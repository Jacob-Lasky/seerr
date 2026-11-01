import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { assertChaptarrRequestSafe } from '../api/servarr/chaptarrInventory.ts';

const require = createRequire(import.meta.url);
const {
  SubjectChangedColumnsComputer,
} = require('typeorm/persistence/SubjectChangedColumnsComputer');

const tree = process.env.W98_CORRECTION_TREE || process.cwd();
const read = (file) => readFileSync(resolve(tree, file), 'utf8');
const strip = (source) => stripTypeScriptTypes(source, { mode: 'transform' });
const noImports = (source) => source.replace(/^import[\s\S]*?;\n/gm, '');
const permissionsSource = read('server/lib/permissions.ts');
const { Permission, hasPermission } = new Function(
  strip(permissionsSource).replace(/\bexport /g, '') +
    ';return {Permission,hasPermission};'
)();
const MediaType = { BOOK: 'book', MOVIE: 'movie', TV: 'tv' };
const MediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  DELETED: 6,
  BLOCKLISTED: 7,
};
const MediaRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
};
const log = { error() {}, warn() {}, info() {}, debug() {} };
const lock = { dispatch: async (_key, fn) => fn() };
const key = (v) => String(v);
const quota = () => ({
  movie: { restricted: false },
  tv: { restricted: false },
  book: { restricted: false },
});

function fixture({
  mode = 'ambiguous',
  mediaType = 'book',
  admin = true,
  serverId = -1,
  is4k = false,
  inventoryModes = {},
} = {}) {
  const events = [],
    checks = [],
    selections = [];
  const bits = admin
    ? Permission.ADMIN
    : Permission.MANAGE_REQUESTS +
      Permission.REQUEST +
      Permission.AUTO_APPROVE +
      Permission.REQUEST_ADVANCED;
  const user = {
    id: 5,
    hasPermission: (p, options) => hasPermission(p, bits, options),
    getQuota: async () => quota(),
  };
  const servers =
    mode === 'no-format'
      ? []
      : [
          {
            id: 10,
            is4k: false,
            isDefault: true,
            apiKey: 'fixture',
            url: 'ebook',
          },
          {
            id: 11,
            is4k: true,
            isDefault: true,
            apiKey: 'fixture',
            url: 'audiobook',
          },
          {
            id: 12,
            is4k: false,
            isDefault: false,
            apiKey: 'fixture',
            url: 'retarget',
          },
        ];
  const settings = { readarr: servers, main: { enableSpecialEpisodes: false } };
  class ReadarrAPI {
    constructor({ url }) {
      this.inventoryMode =
        inventoryModes[servers.find((server) => server.url === url)?.id] ??
        mode;
    }
    static buildUrl(server) {
      selections.push(server.id);
      return server.url;
    }
    async assertBookRequestSafe(id) {
      checks.push(id);
      if (this.inventoryMode === 'stock') return;
      assertChaptarrRequestSafe(
        {
          books:
            this.inventoryMode === 'owned'
              ? [
                  {
                    id: 1,
                    foreignBookId: '123',
                    statistics: { percentOfBooks: 100, bookFileCount: 1 },
                  },
                ]
              : [],
          unmappedOwned: this.inventoryMode === 'ambiguous' ? 1 : 0,
          unmappedRelevant: this.inventoryMode === 'ambiguous' ? 1 : 0,
        },
        id
      );
    }
  }
  class Media {
    constructor(init) {
      Object.assign(this, { requests: [], seasons: [] }, init);
    }
  }
  class SeasonRequest {
    constructor(init) {
      Object.assign(this, init);
    }
  }
  let current;
  let persistedServerId = serverId;
  const repository = {
    findOne: async () => current,
    findOneOrFail: async () => current,
    remove: async (request) => {
      assert.equal(request, current);
      events.push('request-remove');
      current = null;
      return request;
    },
    save: async (request) => {
      // Exercise the installed ORM's real undefined/null change detection.
      const column = {
        propertyName: 'serverId',
        type: Number,
        getEntityValue: (entity) => entity.serverId,
      };
      const subject = {
        entity: request,
        databaseEntity: { serverId: persistedServerId },
        metadata: { columns: [column] },
        changeMaps: [],
        diffColumns: [],
      };
      new SubjectChangedColumnsComputer().computeDiffColumns(subject);
      for (const change of subject.changeMaps) persistedServerId = change.value;
      events.push('request-save');
      // Model the synchronous repository/subscriber boundary. A rejected save must never reach these hooks.
      if (
        request.status === MediaRequestStatus.APPROVED &&
        request.type === 'book'
      )
        events.push('tag', 'add', 'notification');
      return request;
    },
    createQueryBuilder: () => {
      const builder = new Proxy(
        {},
        {
          get: (_t, name) =>
            name === 'getMany' ? async () => [] : () => builder,
        }
      );
      return builder;
    },
  };
  let Entity;
  const getRepository = (kind) =>
    kind === Entity
      ? repository
      : kind === Media
        ? {
            findOne: async () => null,
            findOneOrFail: async () => ({ requests: [], seasons: [] }),
            save: async (m) => {
              events.push('media-save');
              return m;
            },
          }
        : { findOneOrFail: async () => user };
  const entityText = read('server/entity/MediaRequest.ts');
  const errorText = entityText.slice(
    entityText.indexOf('export class RequestPermissionError'),
    entityText.indexOf('type MediaRequestOptions')
  );
  let entityClass = entityText.slice(
    entityText.indexOf('export class MediaRequest'),
    entityText.indexOf('  @PrimaryGeneratedColumn')
  );
  entityClass += 'constructor(init) { Object.assign(this, init); }\n}\n';
  const entityCode = strip(errorText + entityClass).replace(/\bexport /g, '');
  const entityBindings = {
    ReadarrAPI,
    Hardcover: class {
      async getBook(id) {
        return { id, bookFixture: true };
      }
    },
    TheMovieDb: class {
      async getMovie({ movieId }) {
        return { id: movieId, external_ids: {} };
      }
      async getTvShow({ tvId }) {
        return { id: tvId, external_ids: {}, seasons: [{ season_number: 1 }] };
      }
    },
    User: class {},
    getRepository,
    getSettings: () => settings,
    Permission,
    MediaType,
    MediaStatus,
    MediaRequestStatus,
    requestLock: lock,
    mediaLock: lock,
    userKey: key,
    mediaKey: key,
    Media,
    SeasonRequest,
    overrideRules: async () => ({}),
    isBookDetails: (b) => !!b.bookFixture,
    logger: log,
  };
  const exports = new Function(
    ...Object.keys(entityBindings),
    entityCode +
      ';return {MediaRequest,RequestPermissionError,QuotaRestrictedError,DuplicateMediaRequestError,NoSeasonsAvailableError,BlocklistedMediaError};'
  )(...Object.values(entityBindings));
  Entity = exports.MediaRequest;
  current = {
    id: 9,
    type: mediaType,
    is4k,
    serverId,
    status: MediaRequestStatus.PENDING,
    requestedBy: user,
    media: { tmdbId: 123, mediaType },
    seasons: [{ seasonNumber: 1 }],
    createdAt: new Date(),
    ignoreQuota: false,
  };
  const routes = [];
  const router = Object.fromEntries(
    ['get', 'post', 'put', 'delete'].map((method) => [
      method,
      (path, ...handlers) => {
        routes.push({ method, path, handlers });
        return router;
      },
    ])
  );
  const bindings = {
    ...entityBindings,
    ...exports,
    User: class {},
    Router: () => router,
    requestKey: key,
    isAuthenticated: (permission) => (req, _res, next) =>
      req.user?.hasPermission(permission)
        ? next()
        : next({ status: 403, message: 'Denied' }),
  };
  let routeCode = noImports(strip(read('server/routes/request.ts'))).replace(
    'export default requestRoutes;',
    'return requestRoutes;'
  );
  new Function(...Object.keys(bindings), routeCode)(...Object.values(bindings));
  const res = {
    code: undefined,
    status(code) {
      this.code = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
    send() {
      return this;
    },
  };
  const errors = [];
  async function invoke(method, path, body = {}, params = {}) {
    const route = routes.find((r) => r.method === method && r.path === path);
    assert.ok(route, 'actual route registration loaded');
    const req = {
      user,
      body,
      params: { requestId: '9', ...params },
      query: {},
    };
    for (const handler of route.handlers) {
      let continued = false;
      await handler(req, res, (error) => {
        if (error) errors.push(error);
        else continued = true;
      });
      if (errors.length || !continued) break;
    }
    return {
      events,
      errors,
      checks,
      selections,
      res,
      request: current,
      persistedServerId,
    };
  }
  return {
    invoke,
    events,
    checks,
    selections,
    errors,
    current,
    user,
    Entity,
    servers,
  };
}

for (const action of ['create', 'edit', 'retry', 'approve']) {
  for (const mode of ['ambiguous', 'owned', 'no-format']) {
    for (const admin of [true, false]) {
      test(`${action}: ${mode} rejected before saves/hooks, admin=${admin}`, async () => {
        const f = fixture({ mode, admin });
        let result;
        if (action === 'create')
          result = await f.invoke('post', '/', {
            mediaType: 'book',
            mediaId: 123,
            is4k: false,
          });
        if (action === 'edit')
          result = await f.invoke('put', '/:requestId', {
            mediaType: 'book',
            mediaId: 999,
            serverId: 12,
          });
        if (action === 'retry') {
          f.current.status = MediaRequestStatus.FAILED;
          result = await f.invoke('post', '/:requestId/retry');
        }
        if (action === 'approve')
          result = await f.invoke(
            'post',
            '/:requestId/:status',
            {},
            { status: 'approve' }
          );
        assert.deepEqual(
          result.events,
          [],
          'no repository save, tag, add or notification'
        );
        assert.equal(
          result.errors[0]?.status,
          403,
          JSON.stringify(result.errors)
        );
        assert.equal(
          f.current.status,
          action === 'retry'
            ? MediaRequestStatus.FAILED
            : MediaRequestStatus.PENDING
        );
        if (mode !== 'no-format')
          assert.deepEqual(
            result.checks,
            [123],
            'uses persisted work ID on transitions, not body ID'
          );
      });
    }
  }
}
for (const action of ['create', 'edit', 'retry', 'approve']) {
  for (const is4k of [false, true]) {
    test(`${action}: allowed complete inventory resolves format default, is4k=${is4k}`, async () => {
      const f = fixture({ mode: 'allowed', is4k });
      let r;
      if (action === 'create')
        r = await f.invoke('post', '/', {
          mediaType: 'book',
          mediaId: 123,
          is4k,
          serverId: -1,
        });
      if (action === 'edit')
        r = await f.invoke('put', '/:requestId', {
          mediaType: 'book',
          serverId: -1,
        });
      if (action === 'retry') {
        f.current.status = MediaRequestStatus.FAILED;
        r = await f.invoke('post', '/:requestId/retry');
      }
      if (action === 'approve')
        r = await f.invoke(
          'post',
          '/:requestId/:status',
          {},
          { status: 'approve' }
        );
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.selections, [is4k ? 11 : 10]);
      assert.ok(r.events.includes('request-save'));
    });
  }
}
test('retarget uses target server, not original default', async () => {
  const f = fixture({ mode: 'allowed' });
  const r = await f.invoke('put', '/:requestId', {
    mediaType: 'book',
    serverId: 12,
  });
  assert.deepEqual(r.selections, [12]);
  assert.equal(r.request.serverId, 12);
});
test('retarget rejects mismatched format before any save', async () => {
  const f = fixture({ mode: 'allowed' });
  const r = await f.invoke('put', '/:requestId', {
    mediaType: 'book',
    serverId: 11,
  });
  assert.deepEqual(r.events, []);
  assert.equal(r.errors[0]?.status, 403);
});
test('body mediaType cannot bypass a persisted book guard', async () => {
  const f = fixture();
  const r = await f.invoke('put', '/:requestId', {
    mediaType: 'movie',
    serverId: 12,
  });
  assert.deepEqual(r.events, []);
  assert.equal(r.errors[0]?.status, 403);
});
for (const mediaType of ['movie', 'tv']) {
  for (const action of ['create', 'edit', 'retry', 'approve']) {
    test(`${mediaType} ${action} unchanged with no book server`, async () => {
      const f = fixture({ mode: 'no-format', mediaType });
      let r;
      if (action === 'create')
        r = await f.invoke('post', '/', {
          mediaType,
          mediaId: 123,
          seasons: [1],
          is4k: false,
        });
      if (action === 'edit')
        r = await f.invoke('put', '/:requestId', {
          mediaType,
          serverId: 10,
          seasons: [1],
        });
      if (action === 'retry') {
        f.current.status = MediaRequestStatus.FAILED;
        r = await f.invoke('post', '/:requestId/retry');
      }
      if (action === 'approve')
        r = await f.invoke(
          'post',
          '/:requestId/:status',
          {},
          { status: 'approve' }
        );
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.checks, []);
      assert.ok(r.events.includes('request-save'));
    });
  }
}
test('book decline remains permitted despite ambiguous inventory', async () => {
  const f = fixture();
  const r = await f.invoke(
    'post',
    '/:requestId/:status',
    {},
    { status: 'decline' }
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.checks, []);
  assert.deepEqual(r.events, ['request-save']);
});

for (const action of ['retry', 'approve']) {
  test(`${action}: existing management permission check still rejects unauthorized user`, async () => {
    const f = fixture({ mode: 'allowed' });
    f.user.hasPermission = () => false;
    if (action === 'retry') f.current.status = MediaRequestStatus.FAILED;
    const r = await f.invoke(
      'post',
      action === 'retry' ? '/:requestId/retry' : '/:requestId/:status',
      {},
      { status: 'approve' }
    );
    assert.equal(r.errors[0]?.status, 403);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.checks, []);
  });
  test(`${action}: invalid original status remains 409 before inventory access`, async () => {
    const f = fixture({ mode: 'allowed' });
    f.current.status = MediaRequestStatus.COMPLETED;
    const r = await f.invoke(
      'post',
      action === 'retry' ? '/:requestId/retry' : '/:requestId/:status',
      {},
      { status: 'approve' }
    );
    assert.equal(r.errors[0]?.status, 409);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.checks, []);
  });
}
test('book edit trusts persisted format rather than forged body format', async () => {
  const f = fixture({ mode: 'allowed' });
  const r = await f.invoke('put', '/:requestId', {
    mediaType: 'book',
    is4k: true,
    serverId: 11,
  });
  assert.equal(r.errors[0]?.status, 403);
  assert.deepEqual(r.events, []);
  assert.equal(r.request.is4k, false);
});
test('stock transport still permits valid book transition', async () => {
  const f = fixture({ mode: 'stock' });
  f.current.status = MediaRequestStatus.FAILED;
  const r = await f.invoke('post', '/:requestId/retry');
  assert.deepEqual(r.errors, []);
  assert.ok(r.events.includes('request-save'));
});

for (const [defaultMode, overrideMode, allowed] of [
  ['ambiguous', 'allowed', true],
  ['allowed', 'ambiguous', false],
]) {
  test(`effective target: omitted server uses retained override, default=${defaultMode}`, async () => {
    const f = fixture({
      serverId: 12,
      inventoryModes: { 10: defaultMode, 12: overrideMode },
    });
    const result = await f.invoke('put', '/:requestId', { mediaType: 'book' });
    assert.deepEqual(result.selections, [12]);
    assert.equal(result.errors.length, allowed ? 0 : 1);
    assert.equal(result.persistedServerId, 12);
    if (allowed) {
      assert.equal(result.request.serverId, 12);
      assert.ok(result.events.includes('request-save'));
    } else assert.deepEqual(result.events, []);
  });
}
for (const reset of [null, -1]) {
  for (const allowed of [true, false]) {
    test(`effective target: explicit reset ${reset}, default allowed=${allowed}`, async () => {
      const f = fixture({
        serverId: 12,
        inventoryModes: {
          10: allowed ? 'allowed' : 'ambiguous',
          12: allowed ? 'ambiguous' : 'allowed',
        },
      });
      const result = await f.invoke('put', '/:requestId', {
        mediaType: 'book',
        serverId: reset,
      });
      assert.deepEqual(result.selections, [10]);
      assert.equal(result.errors.length, allowed ? 0 : 1);
      assert.equal(result.persistedServerId, allowed ? reset : 12);
      if (!allowed) assert.deepEqual(result.events, []);
    });
  }
}
for (const target of [10, 12]) {
  test(`effective target: explicit retarget ${target} uses destination inventory`, async () => {
    const f = fixture({
      serverId: target === 10 ? 12 : 10,
      inventoryModes: { 10: 'ambiguous', 12: 'allowed' },
    });
    const result = await f.invoke('put', '/:requestId', {
      mediaType: 'book',
      serverId: target,
    });
    assert.deepEqual(result.selections, [target]);
    assert.equal(result.errors.length, target === 12 ? 0 : 1);
    assert.equal(result.persistedServerId, 12);
  });
}

for (const state of [
  'prepared',
  'sending',
  'accepted_pending',
  'unknown',
  'refused',
]) {
  for (const [method, path, body] of [
    ['put', '/:requestId', { mediaType: 'book', serverId: 12 }],
    ['post', '/:requestId/retry', {}],
    ['delete', '/:requestId', {}],
  ])
    test(`durable ${state} refuses ${method} ${path} before all side effects`, async () => {
      const f = fixture({ mode: 'allowed' });
      f.current.status =
        method === 'put'
          ? MediaRequestStatus.PENDING
          : MediaRequestStatus.FAILED;
      f.current.bookRequestIntent = JSON.stringify({ state });
      const result = await f.invoke(method, path, body);
      assert.equal(result.errors[0]?.status, 409);
      assert.deepEqual(result.events, []);
      assert.deepEqual(result.selections, []);
      assert.equal(result.request.bookRequestIntent, JSON.stringify({ state }));
    });
}

// Explicitly confirm real old mutations, separately from the safety assertions.
// The source tree is the retained, hash-verified pre-intent implementation.
for (const [method, path, body] of [
  ['put', '/:requestId', { mediaType: 'book', serverId: 12 }],
  ['post', '/:requestId/retry', {}],
  ['delete', '/:requestId', {}],
]) {
  test(
    `retained old mutation witness ${method}`,
    { skip: process.env.W98_OLD_MUTATION_WITNESS !== '1' },
    async () => {
      assert.ok(
        process.env.W98_CORRECTION_TREE,
        'explicit old source binding required'
      );
      const f = fixture({ mode: 'allowed' });
      f.current.status =
        method === 'put'
          ? MediaRequestStatus.PENDING
          : MediaRequestStatus.FAILED;
      f.current.bookRequestIntent = JSON.stringify({ state: 'unknown' });
      const result = await f.invoke(method, path, body);
      assert.deepEqual(result.errors, []);
      assert.equal(result.res.code, method === 'delete' ? 204 : 200);
      assert.ok(
        result.events.includes(
          method === 'delete' ? 'request-remove' : 'request-save'
        )
      );
      if (method === 'delete') assert.equal(result.request, null);
      if (method === 'post') assert.ok(result.events.includes('add'));
      console.log(
        JSON.stringify({
          old_source_actual_mutation: method,
          status: result.res.code,
          events: result.events,
        })
      );
    }
  );
}
