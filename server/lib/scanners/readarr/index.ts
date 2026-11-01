import type { ReadarrBook } from '@server/api/servarr/readarr';
import ReadarrAPI from '@server/api/servarr/readarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { runBookRequestIntents } from '@server/lib/bookRequestIntentJob';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { ReadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: ReadarrSettings;
  servers: ReadarrSettings[];
};

class ReadarrScanner
  extends BaseScanner<ReadarrBook>
  implements RunnableScanner<SyncStatus>
{
  private servers: ReadarrSettings[];
  private currentServer: ReadarrSettings;
  private readarrApi: ReadarrAPI;

  private checkRunBudget(sessionId: string, deadline: number): void {
    if (this.sessionId !== sessionId) {
      throw new Error('Readarr availability sync was replaced by another run');
    }
    if (!this.running) {
      throw new Error('Readarr availability sync was cancelled');
    }
    if (Date.now() >= deadline) {
      throw new Error(
        'Readarr availability sync exceeded its 14-minute budget'
      );
    }
  }
  private scannedHcIds: Set<number> = new Set();
  private scannedAudioHcIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScanAudio = false;
  private serverInventoryIncomplete = false;
  private serverAudioInventoryIncomplete = false;

  constructor() {
    super('Readarr Scan', { bundleSize: 50 });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    const settings = getSettings();
    const sessionId = this.startRun();
    const deadline = Date.now() + 14 * 60_000;
    const assertActive = () => this.checkRunBudget(sessionId, deadline);
    this.scannedHcIds.clear();
    this.scannedAudioHcIds.clear();
    this.didScanStandard = false;
    this.didScanAudio = false;
    this.serverInventoryIncomplete = false;
    this.serverAudioInventoryIncomplete = false;

    try {
      await runBookRequestIntents();
      assertActive();
      this.servers = uniqWith(settings.readarr, (readarrA, readarrB) => {
        return (
          readarrA.hostname === readarrB.hostname &&
          readarrA.port === readarrB.port &&
          readarrA.baseUrl === readarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        assertActive();
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Readarr server: ${server.name}`,
            'info'
          );

          this.readarrApi = new ReadarrAPI({
            apiKey: server.apiKey,
            url: ReadarrAPI.buildUrl(server, '/api/v1'),
          });

          const items = await this.readarrApi.getBooks();
          assertActive();
          this.items = items;

          const serverAudio = this.enableAudioBook && server.is4k;
          if (!this.readarrApi.inventoryComplete) {
            // Missing HC identities cannot prove an orphan. Preserve existing requests/status.
            if (serverAudio) this.serverAudioInventoryIncomplete = true;
            else this.serverInventoryIncomplete = true;
            this.log(
              'Chaptarr aliases incomplete; orphan cleanup disabled for this format.',
              'warn'
            );
          }

          if (serverAudio) {
            this.didScanAudio = true;
          } else {
            this.didScanStandard = true;
          }

          if (this.items.length === 0) {
            if (serverAudio) {
              this.serverAudioInventoryIncomplete = true;
            } else {
              this.serverInventoryIncomplete = true;
            }
            this.log(
              `Readarr server ${server.name} returned no books. Orphan cleanup for this profile type will be skipped.`,
              'warn'
            );
          }

          await this.loop(
            (book) => this.processReadarrBook(book, assertActive),
            {
              sessionId,
            }
          );
        } else {
          this.log(`Sync not enabled. Skipping Readarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // different genres or languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enableAudioBook || !s.is4k)
        .every((s) => s.syncEnabled);
      const allAudioScanned = this.servers
        .filter((s) => this.enableAudioBook && s.is4k)
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!allAudioScanned) {
        this.didScanAudio = false;
      }

      if (this.serverInventoryIncomplete) {
        this.didScanStandard = false;
      }
      if (this.serverAudioInventoryIncomplete) {
        this.didScanAudio = false;
      }

      await this.cleanupOrphanedBooks(assertActive);
      this.log('Readarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  private async processReadarrBook(
    readarrBook: ReadarrBook,
    assertActive: () => void
  ): Promise<void> {
    assertActive();
    const serverAudio = this.enableAudioBook && this.currentServer.is4k;
    const hcId = parseInt(readarrBook.foreignBookId, 10);

    if (isNaN(hcId)) {
      this.log('Invalid Hardcover ID for book. Skipping item.', 'warn', {
        title: readarrBook.title,
        foreignBookId: readarrBook.foreignBookId,
      });
      return;
    }

    if (serverAudio) {
      this.scannedAudioHcIds.add(hcId);
    } else {
      this.scannedHcIds.add(hcId);
    }

    try {
      const isFullyDownloaded =
        this.readarrApi.isBookFullyDownloaded(readarrBook);

      await this.processBook(hcId, {
        is4k: serverAudio,
        serviceId: this.currentServer.id,
        externalServiceId: readarrBook.id,
        externalServiceSlug: readarrBook.titleSlug,
        title: readarrBook.title,
        processing:
          !isFullyDownloaded && (readarrBook.monitored || readarrBook.grabbed),
        hasFile: isFullyDownloaded,
      });
    } catch (e) {
      this.log('Failed to process Readarr media', 'error', {
        errorMessage: e.message,
        title: readarrBook.title,
      });
    }
  }

  private async existsInAnyServer(
    hcId: number,
    isAudio: boolean,
    assertActive: () => void
  ): Promise<boolean> {
    const servers = this.servers.filter(
      (server) =>
        server.syncEnabled && (this.enableAudioBook && server.is4k) === isAudio
    );

    for (const server of servers) {
      assertActive();
      let book: ReadarrBook;
      try {
        const api = new ReadarrAPI({
          apiKey: server.apiKey,
          url: ReadarrAPI.buildUrl(server, '/api/v1'),
        });
        book = await api.getBookByHcId(hcId);
      } catch (e) {
        // Errors thrown in this catch escape it; do not turn cancellation/deadline
        // into a remote confirmation failure and continue cleanup.
        assertActive();
        this.log(
          `Could not confirm book ${hcId} against Readarr server ${server.name}. Skipping cleanup for it.`,
          'warn',
          { errorMessage: e.message }
        );
        return true;
      }
      // Deliberately OUTSIDE the remote catch: a late result must terminate the run.
      assertActive();
      if (book.id) return true;
    }

    return false;
  }

  private async cleanupOrphanedBooks(assertActive: () => void): Promise<void> {
    assertActive();
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      assertActive();
      const processingBooks = await mediaRepository.find({
        where: { mediaType: MediaType.BOOK, status: MediaStatus.PROCESSING },
        relations: { requests: true },
      });

      assertActive();
      for (const media of processingBooks) {
        assertActive();
        if (!this.scannedHcIds.has(media.tmdbId)) {
          const exists = await this.existsInAnyServer(
            media.tmdbId,
            false,
            assertActive
          );
          assertActive();
          if (exists) continue;

          media.status = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          assertActive();
          await this.declineOrphanedRequests(media, false, assertActive);
          this.log(
            `Book ${media.tmdbId} not found in any Readarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned book cleanup: no standard Readarr servers were scanned.',
        'info'
      );
    }

    if (this.didScanAudio) {
      assertActive();
      const processingAudioBooks = await mediaRepository.find({
        where: {
          mediaType: MediaType.BOOK,
          status4k: MediaStatus.PROCESSING,
        },
        relations: { requests: true },
      });

      assertActive();
      for (const media of processingAudioBooks) {
        assertActive();
        if (!this.scannedAudioHcIds.has(media.tmdbId)) {
          const exists = await this.existsInAnyServer(
            media.tmdbId,
            true,
            assertActive
          );
          assertActive();
          if (exists) continue;

          media.status4k = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          assertActive();
          await this.declineOrphanedRequests(media, true, assertActive);
          this.log(
            `Book ${media.tmdbId} not found in any audiobook Readarr server. Audiobook status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enableAudioBook) {
      this.log(
        'Skipping orphaned audiobook cleanup: no audiobook Readarr servers were scanned.',
        'info'
      );
    }
  }
}

export const readarrScanner = new ReadarrScanner();
