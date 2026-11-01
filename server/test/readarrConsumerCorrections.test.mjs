import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as inventory from '../api/servarr/chaptarrInventory.ts';

const tree = process.env.W98_CORRECTION_TREE || process.cwd();
const load = (path) =>
  stripTypeScriptTypes(
    readFileSync(resolve(tree, path), 'utf8').replace('@EventSubscriber()', ''),
    { mode: 'transform' }
  ).replace(/^import[\s\S]*?;\n/gm, '');
const log = { info() {}, warn() {}, error() {}, debug() {} };
const MediaType = { BOOK: 'book', MOVIE: 'movie', TV: 'tv' };
const MediaStatus = { UNKNOWN: 1, PROCESSING: 3, AVAILABLE: 5, DELETED: 6 };
const MediaRequestStatus = { APPROVED: 2, FAILED: 4 };
const row = (overrides = {}) => ({
  id: 42,
  foreignBookId: '123',
  mediaType: 'ebook',
  title: 'fixture',
  titleSlug: 'fixture',
  monitored: true,
  grabbed: false,
  statistics: { bookFileCount: 0, percentOfBooks: 0 },
  ...overrides,
});
function fixture({
  stock = false,
  rows = [],
  lookup = [row({ id: 0, monitored: false })],
  native,
  cachedNative,
  preventSearch = true,
  audio = false,
  facadeAudio = audio,
} = {}) {
  const calls = [],
    writes = [],
    errors = [];
  const format = facadeAudio ? 'audiobook' : 'ebook';
  const server = {
    id: 10,
    is4k: audio,
    isDefault: true,
    url: stock
      ? 'http://fixture.invalid/api/v1'
      : `http://fixture.invalid/readarr/hc/${format}/api/v1`,
    preventSearch,
    tagRequests: true,
    tags: [],
  };
  class ServarrBase {
    static buildUrl(s) {
      return s.url;
    }
    constructor() {
      this.axios = {
        get: async (path, options = {}) => {
          calls.push(['GET', path]);
          if (path === '/book/paged') {
            const filtered = rows.filter((b) =>
              options.params.downloaded
                ? b.statistics.bookFileCount > 0
                : b.monitored
            );
            return {
              data: {
                offset: options.params.offset,
                pageSize: 100,
                totalCount: filtered.length,
                records: filtered,
              },
            };
          }
          if (path === '/book/lookup') return { data: lookup };
          if (path === '/book/42')
            return { data: native ?? rows.find((b) => b.id === 42) ?? row() };
          if (path === '/edition') return { data: [] };
          throw new Error(`Unexpected fixture GET: ${path}`);
        },
        put: async (path, body) => {
          writes.push(['PUT', path]);
          return { data: body };
        },
        delete: async (path) => {
          writes.push(['DELETE', path]);
          return {};
        },
      };
    }
    async get(path, options) {
      if (path === '/book/42' && cachedNative) return cachedNative;
      return (await this.axios.get(path, options)).data;
    }
    async post(path, body) {
      writes.push(['POST', path]);
      return row({ ...body, id: 42 });
    }
    async getTags() {
      calls.push(['GET', '/tag']);
      return [];
    }
    async createTag() {
      writes.push(['POST', '/tag']);
      return { id: 7 };
    }
    async runCommand(name) {
      writes.push(['COMMAND', name]);
    }
    removeCache() {}
  }
  const API = new Function(
    'ServarrBase',
    'logger',
    ...Object.keys(inventory),
    load('server/api/servarr/readarr.ts').replace(
      'export default ReadarrAPI;',
      'return ReadarrAPI;'
    )
  )(ServarrBase, log, ...Object.values(inventory));
  const api = new API({ url: server.url, apiKey: 'synthetic' });
  class Media {}
  class MediaRequest {
    static sendNotification() {
      calls.push(['NOTIFY']);
    }
  }
  const media = {
    id: 9,
    tmdbId: 123,
    mediaType: 'book',
    status: 3,
    status4k: 3,
    serviceId: 10,
    serviceId4k: 10,
    resetServiceData() {
      writes.push(['LOCAL', 'reset']);
    },
  };
  const entity = {
    id: 8,
    type: 'book',
    status: 2,
    is4k: audio,
    serverId: 10,
    media,
    requestedBy: { id: 5, displayName: 'synthetic' },
  };
  const repository = {
    find: async () => [media],
    findOne: async () => media,
    findOneOrFail: async () => media,
    save: async (value) => {
      calls.push(['SAVE', value === media ? 'media' : 'request']);
      return value;
    },
  };
  const manager = { getRepository: () => repository };
  const settings = { readarr: [server], radarr: [], sonarr: [] };
  const shared = {
    prepareBookRequestIntent: async (value) => {
      if (facadeAudio !== value.is4k) throw new Error('format mismatch');
      calls.push(['PREPARE']);
      value.bookRequestIntentState = 'prepared';
    },
    ReadarrAPI: API,
    logger: log,
    Media,
    MediaRequest,
    MediaType,
    MediaStatus,
    MediaRequestStatus,
    getSettings: () => settings,
    getRepository: () => repository,
    Notification: { MEDIA_FAILED: 'failed' },
    isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    Hardcover: class {
      async getBook() {
        calls.push(['METADATA']);
        return {
          id: 123,
          title: 'synthetic',
          contributions: [{ author: { id: 55 } }],
        };
      }
    },
  };
  const subscriberSource = load(
    'server/subscriber/MediaRequestSubscriber.ts'
  ).replace(
    'export class MediaRequestSubscriber',
    'class MediaRequestSubscriber'
  );
  const Subscriber = new Function(
    ...Object.keys(shared),
    subscriberSource + ';return MediaRequestSubscriber;'
  )(...Object.values(shared));
  async function subscriber() {
    await new Subscriber().sendToReadarr(entity, manager);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async function deletion() {
    const routes = [];
    const router = {
      get() {},
      post() {},
      put() {},
      delete: (path, ...handlers) => routes.push({ path, handlers }),
    };
    const bindings = {
      ...shared,
      Router: () => router,
      Permission: {},
      isAuthenticated: () => (_req, _res, next) => next(),
      EntityNotFoundError: class extends Error {},
    };
    new Function(
      ...Object.keys(bindings),
      load('server/routes/media.ts').replace(
        'export default mediaRoutes;',
        'return mediaRoutes;'
      )
    )(...Object.values(bindings));
    const route = routes.find((r) => r.path === '/:id/file');
    const response = {
      status(code) {
        this.code = code;
        return this;
      },
      send() {},
    };
    await route.handlers.at(-1)(
      { params: { id: '9' }, query: { is4k: String(audio) } },
      response,
      (e) => errors.push(e)
    );
    return response;
  }
  async function presence(cleanup = false, mixed = false) {
    class BaseScanner {
      constructor() {
        this.enableAudioBook = true;
      }
      log() {}
      async declineOrphanedRequests() {
        writes.push(['DECLINE']);
      }
    }
    const bindings = { ...shared, BaseScanner };
    const Scanner = new Function(
      ...Object.keys(bindings),
      load('server/lib/scanners/readarr/index.ts').replace(
        'export const readarrScanner = new ReadarrScanner();',
        'return ReadarrScanner;'
      )
    )(...Object.values(bindings));
    const scanner = new Scanner();
    scanner.servers = mixed
      ? [
          {
            ...server,
            url: 'http://fixture.invalid/api/v1',
            syncEnabled: true,
          },
          { ...server, syncEnabled: true },
        ]
      : [{ ...server, syncEnabled: true }];
    if (cleanup) {
      scanner.didScanStandard = !audio;
      scanner.didScanAudio = audio;
      await scanner.cleanupOrphanedBooks(() => {});
      return;
    }
    return scanner.existsInAnyServer(123, audio, () => {});
  }
  return {
    api,
    calls,
    writes,
    errors,
    media,
    entity,
    subscriber,
    deletion,
    presence,
    cleanup: () => presence(true),
    mixedPresence: () => presence(false, true),
    options: { hcId: 123, authorHcId: 55, searchNow: false },
  };
}

for (const audio of [false, true]) {
  test(`facade miss retains scanner orphan, audio=${audio}`, async () => {
    const f = fixture({ audio });
    assert.equal(await f.presence(), true);
    assert.equal(
      f.calls.some((c) => c[1] === '/book/lookup'),
      false
    );
  });
  test(`facade miss allows identity-intent preparation but still rejects direct add, audio=${audio}`, async () => {
    const f = fixture({ audio });
    await f.api.assertBookRequestSafe(123);
    await assert.rejects(() => f.api.addBook(f.options));
    assert.deepEqual(f.writes, []);
  });
  test(`subscriber miss only prepares before metadata/tag/native link, audio=${audio}`, async () => {
    const f = fixture({ audio });
    await f.subscriber();
    assert.deepEqual(f.writes, []);
    assert.equal(
      f.calls.some((c) => c[0] === 'METADATA'),
      false
    );
    assert.equal(
      f.calls.some((c) => c[1] === 'media'),
      false
    );
    assert.equal(f.entity.status, 2);
    assert.equal(f.entity.bookRequestIntentState, 'prepared');
  });
  test(`subscriber positive defers native linking to committed intent job, audio=${audio}`, async () => {
    const f = fixture({
      audio,
      rows: [row({ mediaType: audio ? 'audiobook' : 'ebook' })],
    });
    await f.subscriber();
    assert.deepEqual(f.writes, []);
    assert.equal(
      f.calls.some((c) => c[0] === 'METADATA'),
      false
    );
    assert.equal(
      f.media[audio ? 'externalServiceId4k' : 'externalServiceId'],
      undefined
    );
    assert.equal(f.media[audio ? 'serviceId4k' : 'serviceId'], 10);
    assert.equal(f.entity.bookRequestIntentState, 'prepared');
    assert.equal(
      f.media[audio ? 'externalServiceId' : 'externalServiceId4k'],
      undefined
    );
    assert.equal(f.entity.status, 2);
    assert.equal(f.media.status, 3);
  });
  test(`facade remove fails before route local success, audio=${audio}`, async () => {
    const f = fixture({ audio });
    const response = await f.deletion();
    assert.equal(f.errors.length, 1);
    assert.notEqual(response.code, 204);
    assert.deepEqual(f.writes, []);
    assert.equal(
      f.calls.some((c) => c[0] === 'SAVE'),
      false
    );
    assert.equal(f.media.status, 3);
    assert.equal(f.media.status4k, 3);
  });
}
for (const rows of [
  [row(), row({ id: 43 })],
  [row({ id: 43 }), row()],
  [row({ foreignBookId: 'gr:123' })],
]) {
  test(`ambiguous/unmapped facade add refuses without mutation (${rows.map((b) => b.id).join(',')})`, async () => {
    const f = fixture({ rows, lookup: rows });
    await assert.rejects(() => f.api.addBook(f.options));
    assert.deepEqual(f.writes, []);
  });
}
for (const native of [
  row({ id: 43 }),
  row({ foreignBookId: '124' }),
  row({ mediaType: 'audiobook' }),
  row({ monitored: false }),
  row({ foreignBookId: 'edition:123' }),
]) {
  test(`fresh native identity/state drift refuses ${JSON.stringify(native)}`, async () => {
    const f = fixture({ rows: [row()], native });
    await assert.rejects(() => f.api.addBook(f.options));
    assert.deepEqual(f.writes, []);
  });
}
test('facade requested search refuses instead of pretending it happened', async () => {
  const f = fixture({ rows: [row()] });
  await assert.rejects(() => f.api.addBook({ ...f.options, searchNow: true }));
  assert.deepEqual(f.writes, []);
});
test('facade owned/unmonitored existing state permits no-op without search', async () => {
  const f = fixture({
    rows: [
      row({
        monitored: false,
        statistics: { bookFileCount: 1, percentOfBooks: 100 },
      }),
    ],
  });
  assert.equal((await f.api.addBook(f.options)).id, 42);
  assert.deepEqual(f.writes, []);
});
test('stock miss retains ordinary orphan absence and request admission', async () => {
  const f = fixture({ stock: true });
  assert.equal(await f.presence(), false);
  await f.api.assertBookRequestSafe(123);
});
test('stock new add and subscriber tag path remain active', async () => {
  const f = fixture({ stock: true });
  await f.subscriber();
  assert.ok(f.writes.some((c) => c[1] === '/tag'));
  assert.ok(f.writes.some((c) => c[1] === '/book'));
  assert.equal(f.media.externalServiceId, 42);
});
test('stock existing unmonitored update remains active', async () => {
  const f = fixture({ stock: true, lookup: [row({ monitored: false })] });
  await f.api.addBook(f.options);
  assert.ok(f.writes.some((c) => c[0] === 'PUT'));
});
test('stock delete still marks local deletion after remote success', async () => {
  const f = fixture({ stock: true, lookup: [row()] });
  const response = await f.deletion();
  assert.equal(response.code, 204);
  assert.ok(f.writes.some((c) => c[0] === 'DELETE'));
  assert.equal(f.media.status, 6);
});

for (const audio of [false, true]) {
  test(`actual cleanup keeps facade unknown media and requests, audio=${audio}`, async () => {
    const f = fixture({ audio });
    await f.cleanup();
    assert.equal(f.media.status, 3);
    assert.equal(f.media.status4k, 3);
    assert.equal(
      f.calls.some((c) => c[0] === 'SAVE'),
      false
    );
    assert.deepEqual(f.writes, []);
  });
}
test('mixed stock absent plus facade unknown retains', async () => {
  const f = fixture();
  assert.equal(await f.mixedPresence(), true);
  assert.deepEqual(f.writes, []);
});
test('stock full cleanup absence still saves and declines', async () => {
  const f = fixture({ stock: true });
  await f.cleanup();
  assert.equal(f.media.status, 1);
  assert.ok(f.calls.some((c) => c[0] === 'SAVE'));
  assert.ok(f.writes.some((c) => c[0] === 'DECLINE'));
});
test('stock existing monitored search still dispatches command', async () => {
  const f = fixture({ stock: true, lookup: [row()] });
  await f.api.addBook({ ...f.options, searchNow: true });
  assert.ok(f.writes.some((c) => c[0] === 'COMMAND'));
});

test('subscriber refuses configured facade format mismatch before writes', async () => {
  const f = fixture({ audio: true, facadeAudio: false, rows: [row()] });
  await f.subscriber();
  assert.equal(f.entity.status, 4);
  assert.equal(
    f.calls.some((c) => c[0] === 'METADATA'),
    false
  );
  assert.equal(f.media.externalServiceId4k, undefined);
  assert.deepEqual(f.writes, []);
});
test('native revalidation bypasses stale cached book metadata', async () => {
  const f = fixture({
    rows: [row()],
    cachedNative: row(),
    native: row({ foreignBookId: '124' }),
  });
  await assert.rejects(() => f.api.addBook(f.options));
  assert.ok(f.calls.some((c) => c[1] === '/book/42'));
  assert.deepEqual(f.writes, []);
});
