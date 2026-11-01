import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DataSource, EntitySchema } from 'typeorm';
import * as inventory from '../api/servarr/chaptarrInventory.ts';
const core = await import(
  process.env.W98_CORE_TREE
    ? pathToFileURL(
        resolve(process.env.W98_CORE_TREE, 'server/lib/bookRequestIntent.ts')
      ).href
    : '../lib/bookRequestIntent.ts'
);

import net from 'node:net';
net.Socket.prototype.connect = function () {
  assert.fail('Network is forbidden in synthetic intent tests');
};
globalThis.fetch = async () =>
  assert.fail('Network is forbidden in synthetic intent tests');

const {
  compareIntent,
  dispatchIntent,
  parseIntent,
  parseIntentResponse,
  requestPayload,
  intentDigest,
  exposeIntentState,
} = core;
const input = {
  workId: 123,
  authorId: 7,
  title: 'Fixture',
  authorName: 'Author',
  format: 'ebook',
  qualityProfile: 1,
  metadataProfile: 2,
  root: '/synthetic',
  tags: [3],
  search: false,
};
const intent = (extra = {}) =>
  JSON.stringify({
    version: 1,
    requestId: 1,
    serverId: 0,
    targetHash: intentDigest('target'),
    workId: 123,
    authorId: 7,
    format: 'ebook',
    payload: requestPayload(input),
    state: 'prepared',
    updatedAt: 1,
    ...extra,
  });
const load = (path, tree = process.cwd()) =>
  stripTypeScriptTypes(
    readFileSync(resolve(tree, path), 'utf8').replace('@EventSubscriber()', ''),
    { mode: 'transform' }
  ).replace(/^import[\s\S]*?;\n/gm, '');

// Fixtures are source-derived from e67374f4, NOT captured live responses.
for (const [status, data, state] of [
  [201, { id: 42 }, 'native_linked'],
  [201, { Id: 42 }, 'native_linked'],
  [201, { id: 42, Id: 43 }, 'unknown'],
  [201, { id: '42' }, 'unknown'],
  [201, { id: 0 }, 'unknown'],
  [201, {}, 'unknown'],
  [202, { pendingId: 5, message: 'Queued' }, 'accepted_pending'],
  [202, { PendingId: 5, Message: 'Queued' }, 'accepted_pending'],
  [202, { pendingId: 5, PendingId: 6, message: 'Queued' }, 'unknown'],
  [202, { pendingId: 5, message: 'Queued', id: 42 }, 'unknown'],
  [202, { pendingId: '5', message: 'Queued' }, 'unknown'],
  [202, { pendingId: 5 }, 'unknown'],
  [409, {}, 'refused'],
  [500, {}, 'unknown'],
  [400, {}, 'unknown'],
])
  test(`source-derived response ${status} ${JSON.stringify(data)}`, () => {
    assert.equal(parseIntentResponse(status, data).state, state);
  });

test('payload preserves independent namespaces, exact audio fields and specific-book compatibility', () => {
  const x = JSON.parse(requestPayload({ ...input, format: 'audiobook' }));
  assert.equal(x.foreignBookId, '123');
  assert.equal(x.author.foreignAuthorId, '7');
  assert.equal(x.author.monitorNewItems, 'none');
  assert.deepEqual(x.author.addOptions.booksToMonitor, ['123']);
  assert.equal(x.author.audiobookQualityProfileId, 1);
  assert.equal(x.author.ebookQualityProfileId, undefined);
  for (const change of [
    { workId: '123' },
    { authorId: '7' },
    { format: 'both' },
    { qualityProfile: 0 },
  ])
    assert.throws(() => requestPayload({ ...input, ...change }));
  // Independent namespaces can legitimately contain the same integer.
  assert.doesNotThrow(() => requestPayload({ ...input, authorId: 123 }));
});
test('stored payload cannot drift independently from work/author/format/envelope', () => {
  for (const change of [
    { workId: 999 },
    { authorId: 999 },
    { format: 'audiobook' },
    { payload: requestPayload({ ...input, authorId: 8 }) },
    { version: 2 },
  ])
    assert.throws(() => parseIntent(intent(change)));
});
test('private intent bytes are absent from JSON/spread while finite UI state remains', () => {
  const entity = { bookRequestIntent: intent() };
  exposeIntentState(entity);
  assert.equal(entity.bookRequestIntentState, 'prepared');
  assert.equal({ ...entity }.bookRequestIntent, undefined);
  assert.ok(!JSON.stringify(entity).includes('/synthetic'));
});

const schema = new EntitySchema({
  name: 'IntentRequest',
  tableName: 'media_request',
  columns: {
    id: { type: Number, primary: true },
    status: { type: Number },
    bookRequestIntent: { type: 'text', nullable: true },
  },
});
async function installDeletionHold(db) {
  // Exercise the actual migration DDL, not a handwritten mirror of its trigger.
  const { TableColumn } = await import('typeorm');
  const Migration = new Function(
    'TableColumn',
    load('server/migration/sqlite/1793534400000-BookRequestIntent.ts').replace(
      'export class',
      'class'
    ) + ';return BookRequestIntent1793534400000;'
  )(TableColumn);
  await new Migration().up({
    addColumn: async () => {},
    query: (sql) => db.query(sql),
  });
}
async function sqliteFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'w98-intent-'));
  const opts = {
    type: 'sqlite',
    database: join(dir, 'fixture.sqlite'),
    entities: [schema],
  };
  const writer = await new DataSource({
    ...opts,
    synchronize: true,
  }).initialize();
  const observer = await new DataSource(opts).initialize();
  await installDeletionHold(writer);
  try {
    await run(writer, observer);
  } finally {
    await observer.destroy();
    await writer.destroy();
    await rm(dir, { recursive: true });
  }
}
test('actual SQLite ORM rollback, transaction refusal and durable claim before single POST', async () => {
  await sqliteFixture(async (db, observer) => {
    await assert.rejects(
      db.transaction(async (manager) => {
        await manager
          .getRepository(schema)
          .save({ id: 1, status: 2, bookRequestIntent: intent() });
        throw new Error('rollback');
      })
    );
    assert.equal(await observer.getRepository(schema).count(), 0);
    await db
      .getRepository(schema)
      .save({ id: 1, status: 2, bookRequestIntent: intent() });
    await db.transaction(async (manager) => {
      await assert.rejects(
        compareIntent(
          manager.getRepository(schema),
          1,
          intent(),
          intent({ state: 'sending' })
        ),
        /must commit/
      );
      await assert.rejects(
        compareIntent(
          db.getRepository(schema),
          1,
          intent(),
          intent({ state: 'sending' })
        ),
        /ambient transaction/
      );
    });
    let posts = 0;
    const io = {
      currentTarget: intentDigest('target'),
      claim: (a, b) => compareIntent(db.getRepository(schema), 1, a, b),
      post: async () => {
        posts++;
        const committed = await observer
          .getRepository(schema)
          .findOneByOrFail({ id: 1 });
        assert.equal(parseIntent(committed.bookRequestIntent).state, 'sending');
        return { status: 202, data: { PendingId: 9, Message: 'Queued' } };
      },
      link: async () => assert.fail('202 cannot link a native id'),
      now: 100,
    };
    await Promise.allSettled([
      dispatchIntent(intent(), io),
      dispatchIntent(intent(), io),
    ]);
    const result = parseIntent(
      (await db.getRepository(schema).findOneByOrFail({ id: 1 }))
        .bookRequestIntent
    );
    assert.equal(posts, 1);
    assert.equal(result.state, 'accepted_pending');
    assert.equal(result.pendingId, 9);
    assert.equal(result.nativeId, undefined);
    await dispatchIntent(JSON.stringify(result), io);
    assert.equal(posts, 1);
  });
});
test('actual SQLite ORM lost response persists unknown, no second POST or new claim', async () => {
  await sqliteFixture(async (db) => {
    await db
      .getRepository(schema)
      .save({ id: 1, status: 2, bookRequestIntent: intent() });
    let posts = 0;
    const io = {
      currentTarget: intentDigest('target'),
      claim: (a, b) => compareIntent(db.getRepository(schema), 1, a, b),
      post: async () => {
        posts++;
        throw new Error('lost reply after submission');
      },
      link: async () => {},
      now: 100,
    };
    await dispatchIntent(intent(), io);
    const raw = (await db.getRepository(schema).findOneByOrFail({ id: 1 }))
      .bookRequestIntent;
    assert.equal(parseIntent(raw).state, 'unknown');
    await dispatchIntent(raw, io);
    await dispatchIntent(intent(), io);
    assert.equal(posts, 1);
  });
});
test('stale sending becomes unknown and target drift never submits', async () => {
  for (const raw of [intent({ state: 'sending' }), intent()]) {
    let saved;
    await dispatchIntent(raw, {
      currentTarget: intentDigest('different'),
      claim: async (a, b) => {
        saved = b;
        return true;
      },
      post: async () => assert.fail('no POST'),
      link: async () => assert.fail('no link'),
      now: 400001,
    });
    assert.equal(
      parseIntent(saved).state,
      parseIntent(raw).state === 'sending' ? 'unknown' : 'refused'
    );
  }
});

test('201 must pass actual fresh native/work/author verification before local mapping', async () => {
  const calls = [];
  class Base {
    constructor() {
      this.axios = {
        get: async (path) => {
          calls.push(path);
          return {
            data: path.startsWith('/book/')
              ? {
                  id: 42,
                  foreignBookId: '123',
                  mediaType: 'ebook',
                  titleSlug: 'fixture',
                  authorId: 10,
                }
              : { id: 10, foreignAuthorId: '7' },
          };
        },
      };
    }
  }
  const API = new Function(
    'ServarrBase',
    'logger',
    ...Object.keys(inventory),
    'positiveId',
    'wireField',
    load('server/api/servarr/readarr.ts').replace(
      'export default ReadarrAPI;',
      'return ReadarrAPI;'
    )
  )(Base, {}, ...Object.values(inventory), core.positiveId, core.wireField);
  const api = new API({
    url: 'http://fixture.invalid/readarr/hc/ebook/api/v1',
    apiKey: 'synthetic',
  });
  const current = parseIntent(intent());
  assert.equal((await api.verifyIntentNative(42, current)).id, 42);
  assert.deepEqual(calls, ['/book/42', '/author/10']);
  await assert.rejects(api.verifyIntentNative(42, { ...current, authorId: 8 }));
  await assert.rejects(api.verifyIntentNative(42, { ...current, workId: 124 }));
  await assert.rejects(
    api.verifyIntentNative(42, { ...current, format: 'audiobook' })
  );
});

function prepareHarness() {
  let persisted = null;
  const calls = [];
  const server = {
    id: 0,
    is4k: false,
    isDefault: true,
    apiKey: 'synthetic',
    activeDirectory: '/synthetic',
    activeProfileId: 1,
    activeMetadataProfileId: 2,
    tags: [3],
    preventSearch: true,
  };
  const request = {
    id: 1,
    type: 'book',
    status: 2,
    is4k: false,
    media: { id: 8, tmdbId: 123 },
    requestedBy: { id: 5 },
    serverId: null,
    bookIntentMetadata: {
      id: 123,
      title: 'Fixture',
      contributions: [{ author: { id: 7, name: 'Author' } }],
    },
  };
  class MR {
    static sendNotification() {
      calls.push('notify');
    }
  }
  class Media {}
  class API {
    static buildUrl() {
      return 'http://fixture.invalid/readarr/hc/ebook/api/v1';
    }
    requestIntentFormat = 'ebook';
    async getExistingChaptarrBookForReconciliation() {
      throw new Error('no exact positive');
    }
  }
  class HC {
    async getBook() {
      assert.fail('No metadata POST in callback');
      return {
        id: 123,
        title: 'Fixture',
        contributions: [{ author: { id: 7, name: 'Author' } }],
      };
    }
  }
  const repo = {
    metadata: { tableName: 'media_request' },
    manager: {
      connection: {
        options: { type: 'sqlite' },
        createQueryRunner: () => ({
          isTransactionActive: false,
          async query(sql, values, structured) {
            assert.equal(structured, true);
            assert.ok(sql.startsWith('UPDATE "media_request"'));
            if (persisted) return { affected: 0 };
            persisted = values[0];
            calls.push('prepared');
            return { affected: 1 };
          },
          async release() {},
        }),
      },
    },
    findOneByOrFail: async () => ({ bookRequestIntent: persisted }),
    createQueryBuilder() {
      let raw;
      const q = {
        update() {
          return q;
        },
        set(x) {
          raw = x.bookRequestIntent;
          return q;
        },
        where() {
          return q;
        },
        callListeners() {
          return q;
        },
        async execute() {
          if (persisted) return { affected: 0 };
          persisted = raw;
          calls.push('prepared');
          return { affected: 1 };
        },
      };
      return q;
    },
    save: async (x) => {
      calls.push(`save:${x.status}`);
    },
  };
  const manager = {
    getRepository: (entity) =>
      entity === Media ? { findOne: async () => ({ id: 8, status: 3 }) } : repo,
  };
  const getSettings = () => ({ readarr: [server] });
  const prepare = new Function(
    'Hardcover',
    'ReadarrAPI',
    'getSettings',
    'MediaRequest',
    ...Object.keys(core),
    load('server/lib/bookRequestIntentJob.ts').replace(/\bexport /g, '') +
      ';return prepareBookRequestIntent;'
  )(HC, API, getSettings, MR, ...Object.values(core));
  const source = load(
    'server/subscriber/MediaRequestSubscriber.ts',
    process.env.W98_INTENT_OLD_TREE || process.cwd()
  );
  const Subscriber = new Function(
    'getSettings',
    'Media',
    'MediaRequest',
    'ReadarrAPI',
    'MediaRequestStatus',
    'MediaStatus',
    'MediaType',
    'logger',
    'isEqual',
    'prepareBookRequestIntent',
    'Notification',
    source.replace(
      'export class MediaRequestSubscriber',
      'class MediaRequestSubscriber'
    ) + ';return MediaRequestSubscriber;'
  )(
    getSettings,
    Media,
    MR,
    API,
    { APPROVED: 2, FAILED: 4, COMPLETED: 5 },
    { AVAILABLE: 5 },
    { BOOK: 'book' },
    { info() {}, warn() {}, error() {} },
    () => true,
    prepare,
    { MEDIA_FAILED: 1 }
  );
  return {
    run: () => new Subscriber().sendToReadarr(request, manager),
    calls,
    request,
    persisted: () => persisted,
    prepare,
    manager,
    server,
  };
}

test('actual approved subscriber prepares intent on a miss, without producer/tag/search writes', async () => {
  const x = prepareHarness();
  await x.run();
  assert.ok(
    x.persisted(),
    'approved request must durably prepare, not fail on a lookup miss'
  );
  assert.equal(parseIntent(x.persisted()).state, 'prepared');
  assert.equal(x.request.status, 2);
  assert.deepEqual(x.calls, ['prepared']);
  await x.run();
  assert.deepEqual(x.calls, ['prepared']);
});

test('actual additive SQLite migration preserves existing row and rolls down in a synthetic DB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w98-migration-'));
  const db = await new DataSource({
    type: 'sqlite',
    database: join(dir, 'fixture.sqlite'),
  }).initialize();
  try {
    await db.query(
      'CREATE TABLE media_request (id INTEGER PRIMARY KEY, status INTEGER NOT NULL)'
    );
    await db.query('INSERT INTO media_request VALUES (1, 2)');
    const { TableColumn } = await import('typeorm');
    const Migration = new Function(
      'TableColumn',
      load(
        'server/migration/sqlite/1793534400000-BookRequestIntent.ts'
      ).replace('export class', 'class') +
        ';return BookRequestIntent1793534400000;'
    )(TableColumn);
    const runner = db.createQueryRunner();
    try {
      await new Migration().up(runner);
      assert.deepEqual(await db.query('SELECT * FROM media_request'), [
        { id: 1, status: 2, bookRequestIntent: null },
      ]);
      await new Migration().down(runner);
      assert.deepEqual(await db.query('SELECT * FROM media_request'), [
        { id: 1, status: 2 },
      ]);
    } finally {
      await runner.release();
    }
  } finally {
    await db.destroy();
    await rm(dir, { recursive: true });
  }
});

test('source-derived 201 fails closed if fresh native validation fails; never resends', async () => {
  let raw = intent(),
    posts = 0;
  const io = {
    currentTarget: intentDigest('target'),
    claim: async (a, b) => {
      if (raw !== a) return false;
      raw = b;
      return true;
    },
    post: async () => {
      posts++;
      return { status: 201, data: { Id: 42 } };
    },
    link: async () => {
      throw new Error('different HC author');
    },
    now: 100,
  };
  await dispatchIntent(raw, io);
  assert.equal(parseIntent(raw).state, 'unknown');
  await dispatchIntent(raw, io);
  assert.equal(posts, 1);
});

test('bounded response refuses oversized success and malformed alias types', () => {
  assert.equal(
    parseIntentResponse(202, { pendingId: 1, message: 'x'.repeat(65536) })
      .state,
    'unknown'
  );
  assert.equal(parseIntentResponse(201, { id: 42, Id: '42' }).state, 'unknown');
  assert.equal(
    parseIntentResponse(202, { pendingId: 1, message: [], Message: 'queue' })
      .state,
    'unknown'
  );
});

test('actual existing-job implementation commits before POST; 202 waits, exact positive later links only locally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w98-job-'));
  class MR {}
  class Media {}
  const mediaSchema = new EntitySchema({
    name: 'JobMedia',
    target: Media,
    tableName: 'media',
    columns: {
      id: { type: Number, primary: true },
      tmdbId: { type: Number },
      externalServiceId: { type: Number, nullable: true },
      serviceId: { type: Number, nullable: true },
      externalServiceSlug: { type: String, nullable: true },
    },
  });
  const requestSchema = new EntitySchema({
    name: 'JobRequest',
    target: MR,
    tableName: 'media_request',
    columns: {
      id: { type: Number, primary: true },
      status: { type: Number },
      type: { type: String },
      is4k: { type: Boolean },
      serverId: { type: Number, nullable: true },
      profileId: { type: Number, nullable: true },
      metadataProfileId: { type: Number, nullable: true },
      rootFolder: { type: String, nullable: true },
      tags: { type: 'simple-json', nullable: true },
      bookRequestIntent: {
        type: 'text',
        nullable: true,
        insert: false,
        update: false,
      },
      updatedAt: { type: Date, updateDate: true },
    },
    relations: {
      media: {
        type: 'many-to-one',
        target: () => Media,
        eager: true,
        joinColumn: true,
      },
    },
  });
  const opts = {
    type: 'sqlite',
    database: join(dir, 'fixture.sqlite'),
    entities: [mediaSchema, requestSchema],
  };
  const db = await new DataSource({ ...opts, synchronize: true }).initialize();
  const observer = await new DataSource(opts).initialize();
  await installDeletionHold(db);
  let posts = 0,
    positive = false,
    nativeChecks = 0,
    metadataQueries = 0;
  const server = {
    id: 0,
    is4k: false,
    isDefault: true,
    apiKey: 'synthetic',
    activeDirectory: '/synthetic',
    activeProfileId: 1,
    activeMetadataProfileId: 2,
    tags: [3],
    preventSearch: true,
  };
  class API {
    requestIntentFormat = 'ebook';
    static buildUrl() {
      return 'http://fixture.invalid/readarr/hc/ebook/api/v1';
    }
    async getIntentPositive() {
      return positive ? { id: 42 } : undefined;
    }
    async verifyIntentNative(id, x) {
      nativeChecks++;
      assert.equal(id, 42);
      assert.equal(x.workId, 123);
      assert.equal(x.authorId, 7);
      assert.equal(x.format, 'ebook');
      return { id: 42, titleSlug: 'fixture' };
    }
    async postBookRequestIntent(payload) {
      posts++;
      assert.equal(JSON.parse(payload).author.foreignAuthorId, '7');
      const stored = await observer
        .getRepository(MR)
        .findOneByOrFail({ id: 1 });
      assert.equal(parseIntent(stored.bookRequestIntent).state, 'sending');
      return { status: 202, data: { PendingId: 5, Message: 'Queued' } };
    }
  }
  class HC {
    async getBook() {
      metadataQueries++;
      return {
        id: 123,
        title: 'Fixture',
        contributions: [{ author: { id: 7, name: 'Author' } }],
      };
    }
  }
  const job = new Function(
    'Hardcover',
    'ReadarrAPI',
    'getRepository',
    'Media',
    'MediaRequest',
    'getSettings',
    'logger',
    ...Object.keys(core),
    load('server/lib/bookRequestIntentJob.ts').replace(/\bexport /g, '') +
      ';return runBookRequestIntents;'
  )(
    HC,
    API,
    (target) => db.getRepository(target),
    Media,
    MR,
    () => ({ readarr: [server] }),
    { warn() {} },
    ...Object.values(core)
  );
  try {
    const media = await db.getRepository(Media).save({ id: 8, tmdbId: 123 });
    await db.getRepository(MR).save({
      id: 1,
      type: 'book',
      status: 2,
      is4k: false,
      serverId: null,
      media,
    });
    await job();
    let stored = await db.getRepository(MR).findOneByOrFail({ id: 1 });
    assert.equal(
      parseIntent(stored.bookRequestIntent).state,
      'accepted_pending'
    );
    assert.equal(stored.media.externalServiceId, null);
    assert.equal(stored.status, 2);
    await job();
    assert.equal(posts, 1);
    assert.equal(metadataQueries, 1);
    positive = true;
    await job();
    stored = await db.getRepository(MR).findOneByOrFail({ id: 1 });
    assert.equal(parseIntent(stored.bookRequestIntent).state, 'native_linked');
    assert.equal(stored.media.externalServiceId, 42);
    assert.equal(stored.media.serviceId, 0);
    assert.equal(stored.status, 2);
    assert.equal(posts, 1);
    assert.equal(nativeChecks, 1);
    await job();
    assert.equal(posts, 1);
  } finally {
    await observer.destroy();
    await db.destroy();
    await rm(dir, { recursive: true });
  }
});

test('callback without an in-memory metadata snapshot queues without any metadata POST', async () => {
  const x = prepareHarness();
  delete x.request.bookIntentMetadata;
  await x.run();
  assert.equal(x.request.bookRequestIntentState, 'prepared');
  assert.equal(x.persisted(), null);
  assert.deepEqual(x.calls, []);
});

test('actual preparation rejects ambiguous and coerced independent HC author metadata without any POST', async () => {
  for (const contributions of [
    [
      { author: { id: 7, name: 'Author' } },
      { author: { id: 8, name: 'Other' } },
    ],
    [{ author: { id: '7', name: 'Author' } }],
    [
      { author: { id: 7, name: 'Author' } },
      { author: { id: 7, name: 'Different' } },
    ],
    [],
  ]) {
    const x = prepareHarness();
    x.request.bookIntentMetadata.contributions = contributions;
    await x.run();
    assert.equal(x.persisted(), null);
    assert.equal(x.request.status, 4);
    assert.ok(!x.calls.includes('prepared'));
  }
});

test('actual SQLite result record survives a user status change during the single POST', async () => {
  await sqliteFixture(async (db) => {
    const repo = db.getRepository(schema);
    await repo.save({ id: 1, status: 2, bookRequestIntent: intent() });
    let posts = 0;
    await dispatchIntent(intent(), {
      currentTarget: intentDigest('target'),
      claim: (a, b) => compareIntent(repo, 1, a, b),
      now: 100,
      post: async () => {
        posts++;
        await repo.update({ id: 1 }, { status: 3 });
        return { status: 202, data: { pendingId: 5, message: 'Queued' } };
      },
      link: async () => assert.fail('no native link'),
    });
    const stored = await repo.findOneByOrFail({ id: 1 });
    assert.equal(stored.status, 3);
    assert.equal(
      parseIntent(stored.bookRequestIntent).state,
      'accepted_pending'
    );
    assert.equal(posts, 1);
  });
});

test('unmigrated synchronize-only SQLite cannot commit sending or POST', async () => {
  await sqliteFixture(async (db) => {
    await db.query('DROP TRIGGER book_request_intent_delete_hold');
    const raw = intent();
    await db
      .getRepository(schema)
      .save({ id: 1, status: 2, bookRequestIntent: raw });
    let posts = 0;
    await assert.rejects(
      () =>
        dispatchIntent(raw, {
          currentTarget: intentDigest('target'),
          claim: (before, after) =>
            compareIntent(db.getRepository(schema), 1, before, after),
          post: async () => {
            posts++;
            return { status: 202, data: { pendingId: 1, message: 'fixture' } };
          },
          link: async () => assert.fail('no native link'),
        }),
      /deletion hold migration is required/
    );
    assert.equal(posts, 0);
    assert.equal(
      (await db.getRepository(schema).findOneByOrFail({ id: 1 }))
        .bookRequestIntent,
      raw
    );
  });
});

test('same SQLite driver overlapping claims cannot nest sending inside another transaction', async () => {
  await sqliteFixture(async (db, observer) => {
    const raw = intent();
    await db
      .getRepository(schema)
      .save({ id: 1, status: 2, bookRequestIntent: raw });
    let posts = 0;
    const send = () =>
      dispatchIntent(raw, {
        currentTarget: intentDigest('target'),
        claim: (before, after) =>
          compareIntent(db.getRepository(schema), 1, before, after),
        post: async () => {
          posts++;
          assert.equal(
            parseIntent(
              (await observer.getRepository(schema).findOneByOrFail({ id: 1 }))
                .bookRequestIntent
            ).state,
            'sending'
          );
          assert.equal(db.createQueryRunner().isTransactionActive, false);
          return { status: 202, data: { pendingId: 2, message: 'fixture' } };
        },
        link: async () => assert.fail('no native link'),
      });
    const results = await Promise.allSettled([send(), send()]);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
    assert.equal(posts, 1);
    assert.equal(
      parseIntent(
        (await observer.getRepository(schema).findOneByOrFail({ id: 1 }))
          .bookRequestIntent
      ).state,
      'accepted_pending'
    );
  });
});
