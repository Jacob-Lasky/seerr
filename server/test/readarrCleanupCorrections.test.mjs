import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as chaptarrInventory from '../api/servarr/chaptarrInventory.ts';

const tree = process.env.W98_CORRECTION_TREE || process.cwd();
const load = (file) =>
  stripTypeScriptTypes(readFileSync(resolve(tree, file), 'utf8'), {
    mode: 'transform',
  }).replace(/^import[\s\S]*?;\n/gm, '');
const MediaType = { BOOK: 'book', MOVIE: 'movie', TV: 'tv' };
const MediaStatus = { UNKNOWN: 1, PROCESSING: 3 };
const MediaRequestStatus = { APPROVED: 2, DECLINED: 3 };

async function fixture(format, stage, positiveRows) {
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  const state = {
    mediaQueries: 0,
    lookups: 0,
    mediaSaves: 0,
    requestSaves: 0,
    notifications: 0,
    lateOperations: [],
    logs: [],
    bookWrites: [],
  };
  let scanner;
  let runNumber = 0;
  const expired = () => clock >= 840000 || (scanner && !scanner.running);
  const operation = (name) => {
    if (expired()) state.lateOperations.push(name);
  };
  const trigger = (name) => {
    if (stage === name + '-deadline') clock = 840001;
    if (stage === name + '-cancel') scanner.cancel();
    if (stage === name + '-restart') {
      scanner.cancel();
      scanner.startRun();
    }
  };
  const is4k = format === 'audiobook';
  const requests = [2, 3].map((id) => ({
    id,
    is4k,
    status: MediaRequestStatus.APPROVED,
  }));
  const orphan = {
    id: 8,
    tmdbId: 999,
    mediaType: 'book',
    status: MediaStatus.PROCESSING,
    status4k: MediaStatus.PROCESSING,
    requests,
  };
  class Media {}
  class MediaRequest {}
  const getRepository = (kind) =>
    kind === Media
      ? {
          find: async () => {
            operation('orphan-query');
            state.mediaQueries++;
            if (
              stage === 'empty-query-deadline' ||
              stage === 'empty-query-cancel'
            ) {
              trigger('empty-query');
              return [];
            }
            trigger('query');
            return [orphan];
          },
          save: async (media) => {
            operation('media-save');
            state.mediaSaves++;
            trigger('media-save');
            return media;
          },
        }
      : {
          save: async (request) => {
            operation('request-save');
            state.requestSaves++;
            state.notifications++;
            if (state.requestSaves === 1) trigger('request-save');
            return request;
          },
        };
  const server = (audio) => ({
    id: audio ? 1 : 0,
    hostname: 'fixture.invalid',
    port: 80,
    baseUrl:
      stage === 'positive-stock'
        ? '/readarr'
        : '/readarr/hc/' + (audio ? 'audiobook' : 'ebook'),
    syncEnabled: true,
    is4k: audio,
  });
  const settings = {
    readarr: stage.startsWith('empty-query')
      ? [server(false), server(true)]
      : [server(is4k)],
    radarr: [],
    sonarr: [],
  };
  const log = { info() {}, debug() {}, warn() {}, error() {} };
  const bindings = {
    getRepository,
    getSettings: () => settings,
    Media,
    MediaRequest,
    MediaType,
    MediaStatus,
    MediaRequestStatus,
    TheMovieDb: class {},
    logger: log,
    AsyncLock: class {
      async dispatch(_key, fn) {
        return fn();
      }
    },
    randomUUID: () => 'fixture-' + ++runNumber,
  };
  const baseSource = load('server/lib/scanners/baseScanner.ts').replace(
    'export default BaseScanner;',
    'return BaseScanner;'
  );
  const RealBase = new Function(...Object.keys(bindings), baseSource)(
    ...Object.values(bindings)
  );
  class FastBase extends RealBase {
    async processBook(hcId, options) {
      state.bookWrites.push({ hcId, ...options });
    }
    async loop(fn) {
      for (const item of this.items) await fn(item);
      trigger('entry');
    }
    log(message) {
      state.logs.push(message);
    }
  }
  class API {
    inventoryComplete = true;
    static buildUrl() {
      return 'http://fixture.invalid';
    }
    async getBooks() {
      return [
        {
          id: 1,
          foreignBookId: '123',
          title: 'synthetic',
          monitored: true,
          statistics: { percentOfBooks: 100 },
        },
      ];
    }
    isBookFullyDownloaded(book) {
      return book.statistics?.percentOfBooks >= 100;
    }
    async getBookByHcId() {
      operation('lookup');
      state.lookups++;
      trigger('lookup');
      if (stage.startsWith('reject-lookup')) {
        trigger('reject-lookup');
        throw new Error('synthetic remote error');
      }
      return { id: 0 };
    }
  }
  let ActualAPI;
  if (positiveRows) {
    class ServarrBase {
      static buildUrl(server) {
        return `http://fixture.invalid${server.baseUrl}/api/v1`;
      }
      async get(path) {
        assert.equal(path, '/book');
        return positiveRows;
      }
      constructor({ url }) {
        this.axios = {
          get: async (path, { params }) => {
            assert.equal(
              path,
              '/book/paged',
              'positive mapping has no lookup fallback'
            );
            const rows = positiveRows.filter((book) =>
              params.downloaded
                ? book.statistics.bookFileCount > 0
                : book.monitored
            );
            return {
              data: {
                offset: params.offset,
                pageSize: params.pageSize,
                totalCount: rows.length,
                records: rows.slice(
                  params.offset,
                  params.offset + params.pageSize
                ),
              },
            };
          },
        };
        state.facade = new URL(url).pathname;
      }
    }
    const apiSource = load('server/api/servarr/readarr.ts').replace(
      'export default ReadarrAPI;',
      'return ReadarrAPI;'
    );
    const apiBindings = { ...chaptarrInventory, ServarrBase, logger: log };
    ActualAPI = new Function(...Object.keys(apiBindings), apiSource)(
      ...Object.values(apiBindings)
    );
  }
  const source = load('server/lib/scanners/readarr/index.ts').replace(
    'export const readarrScanner = new ReadarrScanner();',
    'return ReadarrScanner;'
  );
  const args = {
    runBookRequestIntents: async () => {}, // New job tested separately with real SQLite claims.
    ...bindings,
    BaseScanner: FastBase,
    ReadarrAPI: ActualAPI || API,
    uniqWith: (xs, cmp) =>
      xs.filter((x, i) => !xs.slice(0, i).some((y) => cmp(x, y))),
  };
  const Scanner = new Function(...Object.keys(args), source)(
    ...Object.values(args)
  );
  scanner = new Scanner();
  try {
    if (stage === 'legacy-shared-decline') {
      orphan.mediaType = MediaType.MOVIE;
      await scanner.declineOrphanedRequests(orphan, is4k);
    } else {
      await scanner.run();
    }
    return { ...state, requests, orphan };
  } finally {
    Date.now = originalNow;
  }
}
for (const format of ['ebook', 'audiobook']) {
  for (const stage of [
    'entry',
    'query',
    'lookup',
    'reject-lookup',
    'media-save',
    'request-save',
    'empty-query',
  ]) {
    for (const exit of ['deadline', 'cancel']) {
      test(`${format}: ${stage} crossing ${exit} starts no late cleanup work`, async () => {
        const state = await fixture(format, stage + '-' + exit);
        assert.deepEqual(
          state.lateOperations,
          [],
          'no orphan query, lookup, media save or decline after exit'
        );
        const expectedMedia =
          stage === 'media-save' || stage === 'request-save' ? 1 : 0;
        const expectedRequests = stage === 'request-save' ? 1 : 0;
        assert.equal(
          state.mediaSaves,
          expectedMedia,
          'already-started work may complete, no later media writes'
        );
        assert.equal(
          state.requestSaves,
          expectedRequests,
          'do not continue a multi-request decline loop'
        );
        assert.equal(state.notifications, expectedRequests);
        if (stage === 'entry') assert.equal(state.mediaQueries, 0);
        if (stage === 'query') assert.equal(state.lookups, 0);
        if (stage === 'empty-query')
          assert.equal(
            state.mediaQueries,
            1,
            'no next-format orphan query after budget/cancel'
          );
        if (stage === 'request-save')
          assert.equal(state.requests[1].status, MediaRequestStatus.APPROVED);
        assert.ok(
          state.logs.includes('Scan interrupted'),
          'budget/cancel propagates, not treated as remote absence'
        );
      });
    }
  }
  test(`${format}: valid orphan cleanup still completes`, async () => {
    const s = await fixture(format, 'none');
    assert.deepEqual(s.lateOperations, []);
    assert.equal(s.mediaSaves, 1);
    assert.equal(s.requestSaves, 2);
    assert.equal(s.notifications, 2);
  });
}

for (const format of ['ebook', 'audiobook']) {
  test(`${format}: shared base decline without optional budget callback preserves legacy behavior`, async () => {
    const state = await fixture(format, 'legacy-shared-decline');
    assert.equal(state.requestSaves, 2);
    assert.equal(state.notifications, 2);
    assert.equal(state.mediaQueries, 0);
    assert.equal(state.lookups, 0);
  });
}

for (const format of ['ebook', 'audiobook']) {
  test(`${format}: cancelled run cannot resume cleanup when a new run resets running=true`, async () => {
    const state = await fixture(format, 'lookup-restart');
    assert.equal(state.mediaSaves, 0);
    assert.equal(state.requestSaves, 0);
    assert.ok(state.logs.includes('Scan interrupted'));
  });
}

// Actual inventory -> actual adapter -> actual scanner, with only transport and
// persistence boundaries stubbed. No metadata lookup or live API is involved.
const positiveBook = (id, hc, format, files = 1, percent = 100) => ({
  id,
  foreignBookId: hc,
  mediaType: format,
  title: 'synthetic',
  titleSlug: `native-${id}`,
  monitored: true,
  grabbed: false,
  statistics: { bookFileCount: files, percentOfBooks: percent },
});
for (const format of ['ebook', 'audiobook']) {
  test(`${format}: positive mapping never selects either ambiguous native owner`, async () => {
    const rows = [
      positiveBook(11, '900', format),
      positiveBook(12, '900', format),
      positiveBook(13, '901', format),
    ];
    const s = await fixture(format, 'positive', rows);
    assert.deepEqual(
      s.bookWrites.map((b) => [b.hcId, b.externalServiceId]),
      [[901, 13]],
      'ambiguous HC rows cannot overwrite one another or choose an arbitrary native link'
    );
    assert.equal(s.bookWrites[0].hasFile, true);
    assert.equal(
      s.mediaQueries,
      0,
      'ambiguous inventory disables orphan cleanup'
    );
    assert.equal(s.requestSaves, 0);
  });
  test(`${format}: positive mapping zero files and 100 percent is not available`, async () => {
    const s = await fixture(format, 'positive', [
      positiveBook(11, '900', format, 0),
    ]);
    assert.equal(s.bookWrites.length, 1);
    assert.equal(s.bookWrites[0].hasFile, false);
    assert.equal(s.bookWrites[0].processing, true);
    assert.equal(s.bookWrites[0].externalServiceId, 11);
  });
  test(`${format}: positive mapping keeps unique ownership despite unrelated unmapped rows`, async () => {
    const s = await fixture(format, 'positive', [
      positiveBook(11, '900', format),
      positiveBook(12, 'gr:900', format),
    ]);
    assert.deepEqual(
      s.bookWrites.map((b) => [b.hcId, b.externalServiceId]),
      [[900, 11]]
    );
    assert.equal(s.mediaQueries, 0);
    assert.equal(s.requestSaves, 0);
  });
}

test('stock Readarr retains percentage-only availability semantics', async () => {
  const s = await fixture('ebook', 'positive-stock', [
    positiveBook(11, '900', 'ebook', 0),
  ]);
  assert.equal(s.bookWrites.length, 1);
  assert.equal(s.bookWrites[0].hasFile, true);
  assert.equal(s.bookWrites[0].processing, false);
});
for (const format of ['ebook', 'audiobook']) {
  test(`${format}: partial ownership is processing and unmonitored full ownership stays available`, async () => {
    const rows = [
      positiveBook(11, '900', format, 1, 50),
      { ...positiveBook(12, '901', format), monitored: false },
    ];
    const s = await fixture(format, 'positive', rows);
    assert.deepEqual(
      s.bookWrites.map((b) => [b.hcId, b.hasFile, b.processing]),
      [
        [900, false, true],
        [901, true, false],
      ]
    );
  });
}
