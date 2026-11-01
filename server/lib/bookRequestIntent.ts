import { createHash } from 'crypto';
import type { ObjectLiteral, QueryRunner, Repository } from 'typeorm';

export type IntentState =
  | 'prepared'
  | 'sending'
  | 'accepted_pending'
  | 'native_linked'
  | 'unknown'
  | 'refused';
export type IntentFormat = 'ebook' | 'audiobook';
export interface BookRequestIntent {
  version: 1;
  requestId: number;
  serverId: number;
  targetHash: string;
  workId: number;
  authorId: number;
  format: IntentFormat;
  payload: string;
  state: IntentState;
  updatedAt: number;
  pendingId?: number;
  nativeId?: number;
  responseHash?: string;
  reason?: 'uncertain' | 'ambiguous' | 'target_changed';
}
export const intentDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
export function parseIntent(raw: string): BookRequestIntent {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32768)
    throw new Error('Invalid book intent');
  const x = JSON.parse(raw) as BookRequestIntent;
  if (
    x.version !== 1 ||
    !positiveId(x.requestId) ||
    !Number.isSafeInteger(x.serverId) ||
    x.serverId < 0 ||
    !positiveId(x.workId) ||
    !positiveId(x.authorId) ||
    !['ebook', 'audiobook'].includes(x.format) ||
    !/^[a-f0-9]{64}$/.test(x.targetHash) ||
    typeof x.payload !== 'string' ||
    Buffer.byteLength(x.payload) > 24576 ||
    ![
      'prepared',
      'sending',
      'accepted_pending',
      'native_linked',
      'unknown',
      'refused',
    ].includes(x.state) ||
    !Number.isSafeInteger(x.updatedAt) ||
    x.updatedAt < 0 ||
    (x.pendingId !== undefined && !positiveId(x.pendingId)) ||
    (x.nativeId !== undefined && !positiveId(x.nativeId))
  )
    throw new Error('Invalid book intent');
  const payload = JSON.parse(x.payload);
  const a = payload.author;
  if (
    !a ||
    typeof a !== 'object' ||
    payload.foreignBookId !== String(x.workId) ||
    a.foreignAuthorId !== String(x.authorId) ||
    payload.mediaType !== x.format ||
    x.payload !==
      requestPayload({
        workId: x.workId,
        authorId: x.authorId,
        title: payload.title,
        authorName: a.authorName,
        format: x.format,
        qualityProfile: a[`${x.format}QualityProfileId`],
        metadataProfile: a[`${x.format}MetadataProfileId`],
        root: a[`${x.format}RootFolderPath`],
        tags: a[`${x.format}Tags`],
        search: payload.addOptions?.searchForNewBook,
      })
  )
    throw new Error('Book intent payload binding mismatch');
  return x;
}

/** HC work and author are separate source fields, never edition/provider coercions. */
export function requestPayload(input: {
  workId: number;
  authorId: number;
  title: string;
  authorName: string;
  format: IntentFormat;
  qualityProfile: number;
  metadataProfile: number;
  root: string;
  tags: number[];
  search: boolean;
}): string {
  if (
    !positiveId(input.workId) ||
    !positiveId(input.authorId) ||
    !text(input.title) ||
    !text(input.authorName) ||
    !text(input.root) ||
    !positiveId(input.qualityProfile) ||
    !positiveId(input.metadataProfile) ||
    !['ebook', 'audiobook'].includes(input.format) ||
    typeof input.search !== 'boolean' ||
    !Array.isArray(input.tags) ||
    input.tags.length > 128 ||
    input.tags.some((v) => !positiveId(v))
  )
    throw new Error(
      'Book intent requires exact work, author, format and settings'
    );
  const f = input.format;
  return JSON.stringify({
    foreignBookId: String(input.workId),
    mediaType: f,
    title: input.title,
    monitored: true,
    author: {
      foreignAuthorId: String(input.authorId),
      authorName: input.authorName,
      monitored: true,
      monitorNewItems: 'none',
      [`${f}QualityProfileId`]: input.qualityProfile,
      [`${f}MetadataProfileId`]: input.metadataProfile,
      [`${f}RootFolderPath`]: input.root,
      [`${f}Tags`]: input.tags,
      addOptions: {
        booksToMonitor: [String(input.workId)],
        searchForMissingBooks: false,
      },
    },
    addOptions: { searchForNewBook: input.search },
  });
}

/** Only these two released spellings are accepted, with no conflicting alias. */
export function wireField(
  row: unknown,
  camel: string,
  pascal: string
): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('Invalid response');
  const x = row as Record<string, unknown>;
  const a = Object.prototype.hasOwnProperty.call(x, camel);
  const b = Object.prototype.hasOwnProperty.call(x, pascal);
  if (a && b && JSON.stringify(x[camel]) !== JSON.stringify(x[pascal]))
    throw new Error('Conflicting response aliases');
  return a ? x[camel] : b ? x[pascal] : undefined;
}
export function parseIntentResponse(
  status: number,
  data: unknown
): {
  state: 'accepted_pending' | 'native_linked' | 'unknown' | 'refused';
  id?: number;
} {
  if (Buffer.byteLength(JSON.stringify(data) ?? '') > 65536)
    return { state: 'unknown' };
  try {
    if (status === 201) {
      const id = wireField(data, 'id', 'Id');
      return positiveId(id)
        ? { state: 'native_linked', id }
        : { state: 'unknown' };
    }
    if (status === 202) {
      const id = wireField(data, 'pendingId', 'PendingId');
      const message = wireField(data, 'message', 'Message');
      return positiveId(id) &&
        typeof message === 'string' &&
        message.length <= 4096 &&
        wireField(data, 'id', 'Id') === undefined
        ? { state: 'accepted_pending', id }
        : { state: 'unknown' };
    }
    // Generic errors may follow partial producer effects. Never infer nonadmission.
    return { state: status === 409 ? 'refused' : 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/** Bypass ORM write exclusion only here; fixed identifiers, bound values. */
async function writeIntent<T extends ObjectLiteral>(
  runner: QueryRunner,
  repository: Repository<T>,
  id: number,
  before: string | null,
  after: string,
  approved: boolean
): Promise<number | undefined> {
  const type = repository.manager.connection.options.type;
  if (
    repository.metadata.tableName !== 'media_request' ||
    (type !== 'sqlite' && type !== 'postgres')
  )
    throw new Error('Unsupported book intent storage');
  const values: (string | number)[] = [after, id];
  const parameter = (n: number) => (type === 'postgres' ? `$${n}` : '?');
  let predicate = '"bookRequestIntent" IS NULL';
  if (before !== null) {
    values.push(before);
    predicate = `"bookRequestIntent" = ${parameter(3)}`;
  }
  // Match the prior QueryBuilder's UpdateDateColumn bookkeeping, without
  // switching off normal entity listeners at any ordinary lifecycle callsite.
  const updatedAt = repository.metadata.updateDateColumn;
  if (updatedAt && updatedAt.databaseName !== 'updatedAt')
    throw new Error('Unsupported book intent timestamp column');
  const timestamp = updatedAt ? ', "updatedAt" = CURRENT_TIMESTAMP' : '';
  const result = await runner.query(
    `UPDATE "media_request" SET "bookRequestIntent" = ${parameter(1)}${timestamp} WHERE "id" = ${parameter(2)} AND ${predicate}${approved ? ' AND "status" = 2' : ''}`,
    values,
    true
  );
  return result.affected;
}

/** Preparation can join the subscriber's transaction; dispatch claims cannot. */
export async function prepareIntent<T extends ObjectLiteral>(
  repository: Repository<T>,
  id: number,
  raw: string
): Promise<boolean> {
  const intent = parseIntent(raw);
  if (intent.requestId !== id || intent.state !== 'prepared')
    throw new Error('Invalid prepared intent identity');
  const borrowed = repository.manager.queryRunner;
  const runner = borrowed ?? repository.manager.connection.createQueryRunner();
  // Do not borrow SQLite's shared transaction through an unrelated manager.
  if (!borrowed && runner.isTransactionActive)
    throw new Error('Book intent preparation has an unowned transaction');
  try {
    return (await writeIntent(runner, repository, id, null, raw, true)) === 1;
  } finally {
    if (!borrowed) await runner.release();
  }
}

/** Exact-byte CAS in its own committed transaction; never join an ambient one. */
export async function compareIntent<T extends ObjectLiteral>(
  repository: Repository<T>,
  id: number,
  before: string,
  after: string
): Promise<boolean> {
  if (repository.manager.queryRunner?.isTransactionActive)
    throw new Error('Book intent claim must commit before dispatch');
  // SQLite shares a driver query runner even when the global manager has none.
  // Refuse that ambient transaction too; never POST after an uncommitted claim.
  const runner = repository.manager.connection.createQueryRunner();
  if (runner.isTransactionActive)
    throw new Error('Book intent claim has an ambient transaction');
  let started = false;
  try {
    // synchronize:true can create the column without running migrations. Never
    // admit a producer call unless the atomic deletion hold is installed too.
    const type = repository.manager.connection.options.type;
    const holds =
      type === 'sqlite'
        ? await runner.query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'book_request_intent_delete_hold' AND tbl_name = 'media_request'"
          )
        : type === 'postgres'
          ? await runner.query(
              "SELECT tgname FROM pg_trigger WHERE tgname = 'book_request_intent_delete_hold' AND tgrelid = 'media_request'::regclass AND NOT tgisinternal AND tgenabled IN ('O', 'A')"
            )
          : [];
    if (holds.length !== 1)
      throw new Error('Book intent deletion hold migration is required');
    // The guard query yielded: another task may now own SQLite's shared runner.
    // Recheck immediately before startTransaction, which marks ownership before
    // its first await, instead of accidentally nesting an uncommitted claim.
    if (runner.isTransactionActive)
      throw new Error('Book intent claim has an ambient transaction');
    await runner.startTransaction();
    started = true;
    const affected = await writeIntent(
      runner,
      repository,
      id,
      before,
      after,
      parseIntent(before).state === 'prepared'
    );
    await runner.commitTransaction();
    started = false;
    return affected === 1;
  } catch (error) {
    if (started && runner.isTransactionActive)
      await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export async function dispatchIntent(
  raw: string,
  io: {
    currentTarget: string;
    claim: (before: string, after: string) => Promise<boolean>;
    post: (payload: string) => Promise<{ status: number; data: unknown }>;
    link: (nativeId: number, intent: BookRequestIntent) => Promise<void>;
    now?: number;
  }
): Promise<void> {
  const intent = parseIntent(raw);
  const now = io.now ?? Date.now();
  if (intent.state === 'sending') {
    // A live dispatcher owns its bounded 20s POST; a crash cannot be retried.
    if (now - intent.updatedAt > 300000)
      await io.claim(
        raw,
        JSON.stringify({
          ...intent,
          state: 'unknown',
          reason: 'uncertain',
          updatedAt: now,
        })
      );
    return;
  }
  if (intent.state !== 'prepared') return;
  if (intent.targetHash !== io.currentTarget) {
    await io.claim(
      raw,
      JSON.stringify({
        ...intent,
        state: 'refused',
        reason: 'target_changed',
        updatedAt: now,
      })
    );
    return;
  }
  const sending = JSON.stringify({
    ...intent,
    state: 'sending',
    updatedAt: now,
  });
  if (!(await io.claim(raw, sending))) return;
  let final: BookRequestIntent = {
    ...intent,
    state: 'unknown',
    reason: 'uncertain',
    updatedAt: now,
  };
  try {
    const response = await io.post(intent.payload);
    const result = parseIntentResponse(response.status, response.data);
    final = {
      ...intent,
      state: result.state,
      updatedAt: Date.now(),
      responseHash: intentDigest(JSON.stringify(response.data) ?? ''),
    };
    if (result.state === 'accepted_pending') final.pendingId = result.id;
    if (result.state === 'refused') final.reason = 'ambiguous';
    if (result.state === 'native_linked' && result.id) {
      await io.link(result.id, intent);
      final.nativeId = result.id;
    }
  } catch {
    final.state = 'unknown';
    final.reason = 'uncertain';
  }
  await io.claim(sending, JSON.stringify(final));
}

/** Keep private payload/root/target bytes off ordinary entity JSON and spreads. */
export function exposeIntentState(entity: {
  bookRequestIntent?: string | null;
  bookRequestIntentState?: IntentState;
}): void {
  if (entity.bookRequestIntent != null) {
    try {
      entity.bookRequestIntentState = parseIntent(
        entity.bookRequestIntent
      ).state;
    } catch {
      entity.bookRequestIntentState = 'unknown';
    }
  }
  Object.defineProperty(entity, 'bookRequestIntent', {
    value: entity.bookRequestIntent,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
