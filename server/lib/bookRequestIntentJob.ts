import Hardcover from '@server/api/hardcover';
import type { HardcoverBookDetails } from '@server/api/hardcover/interfaces';
import ReadarrAPI from '@server/api/servarr/readarr';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import {
  compareIntent,
  dispatchIntent,
  exposeIntentState,
  intentDigest,
  parseIntent,
  positiveId,
  prepareIntent,
  requestPayload,
  type BookRequestIntent,
} from '@server/lib/bookRequestIntent';
import { getSettings, type ReadarrSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';

function targetHash(server: ReadarrSettings, request: MediaRequest): string {
  // Include credentials in the digest, never in the durable payload or output.
  return intentDigest(
    JSON.stringify({
      serverId: server.id,
      effectiveServerId:
        request.serverId != null && request.serverId >= 0
          ? request.serverId
          : getSettings().readarr.find(
              (s) => s.isDefault && s.is4k === request.is4k
            )?.id,
      url: ReadarrAPI.buildUrl(server, '/api/v1'),
      apiKey: server.apiKey,
      is4k: server.is4k,
      root: request.rootFolder || server.activeDirectory,
      quality: request.profileId || server.activeProfileId,
      metadata: request.metadataProfileId || server.activeMetadataProfileId,
      tags: request.tags ?? server.tags ?? [],
      search: !server.preventSearch,
    })
  );
}

/** Called inside ORM callbacks: only a local preparation, no producer write. */
export async function prepareBookRequestIntent(
  request: MediaRequest,
  manager: EntityManager,
  server: ReadarrSettings,
  options: {
    root: string;
    qualityProfile: number;
    metadataProfile: number;
    tags: number[];
  },
  metadata?: HardcoverBookDetails
): Promise<void> {
  const repo = manager.getRepository(MediaRequest);
  const persisted = await repo.findOneByOrFail({ id: request.id });
  if (persisted.bookRequestIntent != null) {
    request.bookRequestIntent = persisted.bookRequestIntent;
    exposeIntentState(request);
    return;
  }
  const format = request.is4k ? 'audiobook' : 'ebook';
  const api = new ReadarrAPI({
    url: ReadarrAPI.buildUrl(server, '/api/v1'),
    apiKey: server.apiKey,
  });
  if (api.requestIntentFormat !== format)
    throw new Error('Book intent facade mismatch');
  const book =
    metadata ??
    (request as MediaRequest & { bookIntentMetadata?: HardcoverBookDetails })
      .bookIntentMetadata;
  if (!book) {
    // Approval of an older pending request has no in-memory metadata snapshot.
    // Its committed APPROVED row is picked up by the existing job, not an HTTP callback.
    request.bookRequestIntentState = 'prepared';
    return;
  }
  if (book.id !== request.media.tmdbId || !positiveId(book.id))
    throw new Error('Book identity mismatch');
  // All retained contribution identities must agree. Never choose the first author.
  const authors = book.contributions.map((c) => c.author);
  if (
    !authors.length ||
    authors.some(
      (a) =>
        !positiveId(a.id) ||
        !a.name ||
        a.id !== authors[0].id ||
        a.name !== authors[0].name
    )
  )
    throw new Error('An unambiguous independent HC author is required');
  const payload = requestPayload({
    workId: book.id,
    authorId: authors[0].id,
    title: book.title,
    authorName: authors[0].name,
    format,
    ...options,
    search: !server.preventSearch,
  });
  const intent: BookRequestIntent = {
    version: 1,
    requestId: request.id,
    serverId: server.id,
    targetHash: targetHash(server, request),
    workId: book.id,
    authorId: authors[0].id,
    format,
    payload,
    state: 'prepared',
    updatedAt: Date.now(),
  };
  const raw = JSON.stringify(intent);
  const prepared = await prepareIntent(repo, request.id, raw);
  request.bookRequestIntent = prepared
    ? raw
    : (await repo.findOneByOrFail({ id: request.id })).bookRequestIntent;
  exposeIntentState(request);
}

/** Existing scheduled/manual Readarr scan owns this bounded committed-row job. */
export async function runBookRequestIntents(): Promise<void> {
  const repo = getRepository(MediaRequest);
  if (repo.manager.queryRunner?.isTransactionActive)
    throw new Error('Intent job cannot run inside a transaction');
  const servers = getSettings().readarr;
  const facades = servers.filter(
    (s) =>
      new ReadarrAPI({
        url: ReadarrAPI.buildUrl(s, '/api/v1'),
        apiKey: s.apiKey,
      }).requestIntentFormat
  );
  const clauses: string[] = [];
  const params: Record<string, unknown> = {
    type: 'book',
    status: 2,
    linked: '%"state":"native_linked"%',
  };
  if (facades.length) {
    clauses.push('request.serverId IN (:...facadeIds)');
    params.facadeIds = facades.map((s) => s.id);
    for (const audio of [false, true]) {
      if (facades.some((s) => s.isDefault && s.is4k === audio)) {
        const key = audio ? 'audio' : 'ebook';
        params[key] = audio;
        clauses.push(
          `((request.serverId IS NULL OR request.serverId < 0) AND request.is4k = :${key})`
        );
      }
    }
  }
  const query = repo
    .createQueryBuilder('request')
    .leftJoinAndSelect('request.media', 'media')
    .where('request.type = :type AND request.status = :status', params);
  query.andWhere(
    `((request.bookRequestIntent IS NOT NULL AND request.bookRequestIntent NOT LIKE :linked)${
      clauses.length
        ? ` OR (request.bookRequestIntent IS NULL AND (${clauses.join(' OR ')}))`
        : ''
    })`,
    params
  );
  // Existing job only: rotate held rows without a new queue/daemon.
  const rows = await query
    .orderBy('request.updatedAt', 'ASC')
    .take(5)
    .getMany();
  for (const request of rows) {
    const originalRaw = request.bookRequestIntent;
    try {
      if (request.bookRequestIntent == null) {
        const selected =
          request.serverId != null && request.serverId >= 0
            ? servers.find((s) => s.id === request.serverId)
            : servers.find((s) => s.isDefault && s.is4k === request.is4k);
        if (!selected || selected.is4k !== request.is4k) continue;
        // This job has no ambient transaction. Metadata query is before the
        // prepared row commit; producer POST is only after a separate sending claim.
        const metadata = await new Hardcover().getBook(request.media.tmdbId);
        await prepareBookRequestIntent(
          request,
          repo.manager,
          selected,
          {
            root: request.rootFolder || selected.activeDirectory,
            qualityProfile: request.profileId || selected.activeProfileId,
            metadataProfile:
              request.metadataProfileId || selected.activeMetadataProfileId,
            tags: request.tags ?? selected.tags ?? [],
          },
          metadata
        );
      }
      if (request.bookRequestIntent == null) continue;
      const raw = request.bookRequestIntent;
      const intent = parseIntent(raw);
      if (
        intent.requestId !== request.id ||
        intent.workId !== request.media.tmdbId ||
        intent.format !== (request.is4k ? 'audiobook' : 'ebook')
      )
        throw new Error('Intent binding mismatch');
      const server = getSettings().readarr.find(
        (s) => s.id === intent.serverId
      );
      if (!server) continue; // Held under the original identity, never reroute to default.
      const hash = targetHash(server, request);
      const api = new ReadarrAPI({
        url: ReadarrAPI.buildUrl(server, '/api/v1'),
        apiKey: server.apiKey,
      });
      const claim = (before: string, after: string) =>
        compareIntent(repo, request.id, before, after);
      const link = async (id: number, current: BookRequestIntent) => {
        const book = await api.verifyIntentNative(id, current);
        await repo.manager.transaction(async (manager) => {
          const liveRequest = await manager
            .getRepository(MediaRequest)
            .findOneByOrFail({ id: request.id });
          const liveServer = getSettings().readarr.find(
            (s) => s.id === current.serverId
          );
          const liveIntent = parseIntent(liveRequest.bookRequestIntent ?? '');
          if (
            liveRequest.status !== 2 ||
            !liveServer ||
            targetHash(liveServer, liveRequest) !== current.targetHash ||
            liveIntent.payload !== current.payload ||
            liveIntent.targetHash !== current.targetHash ||
            liveRequest.media.tmdbId !== current.workId ||
            liveRequest.is4k !== (current.format === 'audiobook')
          )
            throw new Error(
              'Intent target changed before local reconciliation'
            );
          const media = await manager
            .getRepository(Media)
            .findOneByOrFail({ id: request.media.id });
          const key = request.is4k
            ? 'externalServiceId4k'
            : 'externalServiceId';
          const serviceKey = request.is4k ? 'serviceId4k' : 'serviceId';
          if (
            media[key] != null &&
            (media[key] !== id || media[serviceKey] !== server.id)
          )
            throw new Error('Do not overwrite an existing book identity');
          media[key] = id;
          media[serviceKey] = server.id;
          media[
            request.is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'
          ] = book.titleSlug;
          await manager.getRepository(Media).save(media);
        });
      };
      if (intent.state === 'sending') {
        await dispatchIntent(raw, {
          currentTarget: hash,
          claim,
          post: (payload) => api.postBookRequestIntent(payload),
          link,
        });
      } else if (
        hash === intent.targetHash &&
        intent.state !== 'native_linked'
      ) {
        // Fresh incomplete/ambiguous inventory vetoes submission. A miss is NOT
        // absence authority: only this explicit identity-bound producer intent adds.
        const book = await api.getIntentPositive(intent);
        if (book) {
          await link(book.id, intent);
          await claim(
            raw,
            JSON.stringify({
              ...intent,
              state: 'native_linked',
              nativeId: book.id,
              updatedAt: Date.now(),
            })
          );
        } else if (intent.state === 'prepared') {
          await dispatchIntent(raw, {
            currentTarget: hash,
            claim,
            post: (payload) => api.postBookRequestIntent(payload),
            link,
          });
        }
      } else if (intent.state === 'prepared') {
        await dispatchIntent(raw, {
          currentTarget: hash,
          claim,
          post: (payload) => api.postBookRequestIntent(payload),
          link,
        });
      }
    } catch {
      if (originalRaw == null && request.bookRequestIntent == null) {
        // Known pre-preparation failure: there was no sending claim or producer
        // call. Surface normal FAILED/retry UI instead of pretending it is queued.
        await repo
          .createQueryBuilder()
          .update()
          .set({ status: 4 })
          .where(
            'id = :id AND status = :status AND bookRequestIntent IS NULL',
            { id: request.id, status: 2 }
          )
          .callListeners(false)
          .execute();
      }
      logger.warn('Book intent held; no submission retry was made', {
        label: 'Book Request',
        requestId: request.id,
      });
    } finally {
      // Fairness metadata only, never a state rebaseline or resend. A malformed
      // row stays held without preventing stock scans or the next queued row.
      try {
        const touch = repo
          .createQueryBuilder()
          .update()
          .set({ updatedAt: new Date() })
          .where('id = :id', { id: request.id });
        if (originalRaw != null)
          touch.andWhere('bookRequestIntent = :raw', { raw: originalRaw });
        else touch.andWhere('bookRequestIntent IS NULL');
        await touch.callListeners(false).execute();
      } catch {
        logger.warn('Book intent fairness timestamp not recorded', {
          label: 'Book Request',
          requestId: request.id,
        });
      }
    }
  }
}
