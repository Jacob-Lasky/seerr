import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import net from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  DataSource,
  EntitySchema,
  EventSubscriber,
  TableColumn,
} from 'typeorm';
import ts from 'typescript';
const core = await import(
  process.env.W98_STALE_TREE
    ? 'data:text/javascript;base64,' +
      Buffer.from(
        stripTypeScriptTypes(
          readFileSync(
            resolve(
              process.env.W98_STALE_TREE,
              'server/lib/bookRequestIntent.ts'
            ),
            'utf8'
          ),
          { mode: 'transform' }
        )
      ).toString('base64')
    : '../lib/bookRequestIntent.ts'
);
net.Socket.prototype.connect = () => assert.fail('network forbidden');
globalThis.fetch = async () => assert.fail('network forbidden');
const root = process.env.W98_STALE_TREE || process.cwd();
const entity = ts.createSourceFile(
  'MediaRequest.ts',
  readFileSync(resolve(root, 'server/entity/MediaRequest.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
const cls = entity.statements.find(
  (x) => ts.isClassDeclaration(x) && x.name?.text === 'MediaRequest'
);
const property = cls.members.find(
  (x) => x.name?.getText(entity) === 'bookRequestIntent'
);
const decorator = ts
  .getDecorators(property)
  .find((x) => x.expression.expression?.getText(entity) === 'Column');
// Use the ACTUAL production decorator's options, including insert/update policy.
const intentColumn = new Function(
  `return (${decorator.expression.arguments[0].getText(entity)})`
)();
const strip = (path) =>
  stripTypeScriptTypes(
    readFileSync(resolve(process.cwd(), path), 'utf8').replace(
      '@EventSubscriber()',
      ''
    ),
    { mode: 'transform' }
  ).replace(/^import[\s\S]*?;\n/gm, '');
const Migration = new Function(
  'TableColumn',
  strip('server/migration/sqlite/1793534400000-BookRequestIntent.ts').replace(
    'export class',
    'class'
  ) + ';return BookRequestIntent1793534400000;'
)(TableColumn);
class Request {}
class SeasonRequest {}
const Subscriber = new Function(
  'SeasonRequest',
  'MediaRequest',
  'MediaRequestStatus',
  'MediaStatus',
  'MediaType',
  'In',
  strip('server/subscriber/MediaSubscriber.ts').replace(
    'export class',
    'class'
  ) + ';return MediaSubscriber;'
)(
  SeasonRequest,
  Request,
  { PENDING: 1, APPROVED: 2, FAILED: 4, COMPLETED: 5 },
  { AVAILABLE: 5, DELETED: 6 },
  { MOVIE: 'movie', BOOK: 'book', TV: 'tv' },
  (x) => x
);
const raw = (state) =>
  JSON.stringify({
    version: 1,
    requestId: 1,
    serverId: 0,
    targetHash: core.intentDigest('target'),
    workId: 123,
    authorId: 7,
    format: 'ebook',
    payload: core.requestPayload({
      workId: 123,
      authorId: 7,
      title: 'Fixture',
      authorName: 'Author',
      format: 'ebook',
      qualityProfile: 1,
      metadataProfile: 2,
      root: '/synthetic',
      tags: [],
      search: false,
    }),
    state,
    updatedAt: 1,
  });
async function fixture(run) {
  const events = [];
  class Recorder {
    listenTo() {
      return Request;
    }
    afterUpdate(event) {
      events.push(event.updatedColumns.map((x) => x.propertyName));
    }
  }
  EventSubscriber()(Recorder);
  const schema = new EntitySchema({
    name: 'Request',
    target: Request,
    tableName: 'media_request',
    columns: {
      id: { type: Number, primary: true },
      status: { type: Number },
      is4k: { type: Boolean, default: false },
      ownerId: { type: Number, default: 5 },
      updatedAt: { type: Date, updateDate: true },
      mediaId: { type: Number, default: 8 },
      bookRequestIntent: intentColumn,
    },
  });
  const db = await new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [schema],
    subscribers: [Recorder],
  }).initialize();
  try {
    await db.query(
      'CREATE TABLE media_request(id integer PRIMARY KEY,status integer NOT NULL,is4k boolean NOT NULL DEFAULT 0,ownerId integer NOT NULL DEFAULT 5,updatedAt datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,mediaId integer NOT NULL DEFAULT 8)'
    );
    await new Migration().up(db.createQueryRunner());
    const repo = db.getRepository(Request);
    await repo.save({ id: 1, status: 2 });
    await run({ db, repo, events });
  } finally {
    await db.destroy();
  }
}
for (const staleState of [null, 'prepared', 'sending', 'accepted_pending']) {
  test(`actual availability caller retains latest admission over stale ${staleState}`, () =>
    fixture(async ({ db, repo, events }) => {
      // Fixture setup alone uses SQL: include stale nonnull bytes as well as null.
      if (staleState)
        await db.query(
          'UPDATE media_request SET bookRequestIntent=? WHERE id=1',
          [raw(staleState)]
        );
      let latest,
        posts = 0;
      const wrapped = {
        find: async () => {
          const rows = await repo.find();
          rows.forEach(core.exposeIntentState);
          if (staleState === null || staleState === 'prepared') {
            if (staleState === null) {
              // Old snapshot has no preparation helper: reproduce the old
              // writer's committed setup; candidate exercises its actual helper.
              if (core.prepareIntent)
                await core.prepareIntent(repo, 1, raw('prepared'));
              else await repo.update(1, { bookRequestIntent: raw('prepared') });
            }
            await core.dispatchIntent(raw('prepared'), {
              currentTarget: core.intentDigest('target'),
              claim: (a, b) => core.compareIntent(repo, 1, a, b),
              post: async () => {
                posts++;
                return {
                  status: 202,
                  data: { pendingId: 9, message: 'Queued' },
                };
              },
              link: async () => assert.fail('202 cannot link'),
            });
          } else {
            // Simulate completion of an already admitted POST or exact-positive
            // reconciliation, never an invalid transition back to prepared.
            const after = JSON.stringify({
              ...JSON.parse(raw(staleState)),
              state:
                staleState === 'sending' ? 'accepted_pending' : 'native_linked',
              ...(staleState === 'sending'
                ? { pendingId: 9 }
                : { nativeId: 42 }),
              updatedAt: 2,
            });
            assert.equal(
              await core.compareIntent(repo, 1, raw(staleState), after),
              true
            );
          }
          latest = (await repo.findOneByOrFail({ id: 1 })).bookRequestIntent;
          assert.equal(
            core.parseIntent(latest).state,
            staleState === 'accepted_pending'
              ? 'native_linked'
              : 'accepted_pending'
          );
          return rows;
        },
        save: (rows) => repo.save(rows),
      };
      await new Subscriber().updateRelatedMediaRequest(
        { getRepository: (target) => (target === Request ? wrapped : {}) },
        { id: 8, status: 5, mediaType: 'book' },
        { id: 8, status: 3 },
        false
      );
      const stored = await repo.findOneByOrFail({ id: 1 });
      assert.equal(
        posts,
        staleState === null || staleState === 'prepared' ? 1 : 0
      );
      assert.equal(stored.status, 5);
      assert.ok(
        events.some((columns) => columns.includes('status')),
        'ordinary save still invokes status subscriber'
      );
      assert.equal(
        stored.bookRequestIntent,
        latest,
        'stale entity save must retain exact latest intent'
      );
      await assert.rejects(repo.delete(1), /BOOK_REQUEST_INTENT_DELETE_HELD/);
    }));
}
test('ordinary owner/status save and scoped update cannot regress intent', () =>
  fixture(async ({ db, repo, events }) => {
    const stale = await repo.findOneByOrFail({ id: 1 });
    await db.query('UPDATE media_request SET bookRequestIntent=? WHERE id=1', [
      raw('unknown'),
    ]);
    stale.ownerId = 9;
    stale.bookRequestIntent = raw('prepared');
    await repo.save(stale);
    assert.equal(
      (await repo.findOneByOrFail({ id: 1 })).bookRequestIntent,
      raw('unknown')
    );
    assert.equal((await repo.findOneByOrFail({ id: 1 })).ownerId, 9);
    assert.ok(events.some((x) => x.includes('ownerId')));
    await repo.update(1, { status: 4, bookRequestIntent: null });
    const result = await repo.findOneByOrFail({ id: 1 });
    assert.equal(result.status, 4);
    assert.equal(result.bookRequestIntent, raw('unknown'));
  }));
test('ordinary insertion cannot manufacture an intent', () =>
  fixture(async ({ repo }) => {
    await repo.save({ id: 2, status: 2, bookRequestIntent: raw('sending') });
    assert.equal(
      (await repo.findOneByOrFail({ id: 2 })).bookRequestIntent,
      null
    );
  }));
test('dedicated preparation respects approval, exact once and caller transaction rollback', () =>
  fixture(async ({ db, repo }) => {
    assert.equal(await core.prepareIntent(repo, 1, raw('prepared')), true);
    assert.equal(await core.prepareIntent(repo, 1, raw('prepared')), false);
    await repo.save({ id: 2, status: 1 });
    await assert.rejects(
      core.prepareIntent(repo, 2, raw('prepared')),
      /identity/
    );
    const two = JSON.stringify({
      ...JSON.parse(raw('prepared')),
      requestId: 2,
    });
    assert.equal(await core.prepareIntent(repo, 2, two), false);
    await repo.save({ id: 3, status: 2 });
    const three = JSON.stringify({
      ...JSON.parse(raw('prepared')),
      requestId: 3,
    });
    await assert.rejects(
      db.transaction(async (manager) => {
        assert.equal(
          await core.prepareIntent(manager.getRepository(Request), 3, three),
          true
        );
        throw Error('rollback witness');
      }),
      /rollback witness/
    );
    assert.equal(
      (await repo.findOneByOrFail({ id: 3 })).bookRequestIntent,
      null
    );
  }));

test('dedicated writes keep update timestamp behavior without ordinary subscribers', () =>
  fixture(async ({ db, repo, events }) => {
    await db.query(
      "UPDATE media_request SET updatedAt='2000-01-01 00:00:00' WHERE id=1"
    );
    assert.equal(await core.prepareIntent(repo, 1, raw('prepared')), true);
    assert.notEqual(
      (await repo.findOneByOrFail({ id: 1 })).updatedAt.toISOString(),
      '2000-01-01T00:00:00.000Z'
    );
    assert.equal(events.length, 0);
    const before = (await repo.findOneByOrFail({ id: 1 })).bookRequestIntent;
    assert.equal(
      await core.compareIntent(repo, 1, before, raw('sending')),
      true
    );
    assert.equal(
      await core.compareIntent(repo, 1, before, raw('unknown')),
      false
    );
    assert.equal(
      (await repo.findOneByOrFail({ id: 1 })).bookRequestIntent,
      raw('sending')
    );
  }));

test('preparation refuses an unrelated shared SQLite transaction', () =>
  fixture(async ({ db, repo }) => {
    await db.transaction(async () => {
      await assert.rejects(
        core.prepareIntent(repo, 1, raw('prepared')),
        /unowned transaction/
      );
    });
    assert.equal(
      (await repo.findOneByOrFail({ id: 1 })).bookRequestIntent,
      null
    );
  }));

test('Postgres dedicated writer binds positional values (driver contract only, not live PG)', async () => {
  const calls = [];
  const runner = {
    isTransactionActive: false,
    async release() {
      calls.push('release');
    },
    async startTransaction() {
      this.isTransactionActive = true;
    },
    async commitTransaction() {
      this.isTransactionActive = false;
    },
    async rollbackTransaction() {
      this.isTransactionActive = false;
    },
    async query(sql, values, structured) {
      if (sql.startsWith('SELECT tgname'))
        return [{ tgname: 'book_request_intent_delete_hold' }];
      calls.push({ sql, values, structured });
      return { affected: 1 };
    },
  };
  const repo = {
    metadata: {
      tableName: 'media_request',
      updateDateColumn: { databaseName: 'updatedAt' },
    },
    manager: {
      connection: {
        options: { type: 'postgres' },
        createQueryRunner: () => runner,
      },
    },
  };
  assert.equal(await core.prepareIntent(repo, 1, raw('prepared')), true);
  assert.equal(
    await core.compareIntent(repo, 1, raw('prepared'), raw('sending')),
    true
  );
  const writes = calls.filter((x) => typeof x === 'object');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], {
    sql: 'UPDATE "media_request" SET "bookRequestIntent" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2 AND "bookRequestIntent" IS NULL AND "status" = 2',
    values: [raw('prepared'), 1],
    structured: true,
  });
  assert.deepEqual(writes[1], {
    sql: 'UPDATE "media_request" SET "bookRequestIntent" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2 AND "bookRequestIntent" = $3 AND "status" = 2',
    values: [raw('sending'), 1, raw('prepared')],
    structured: true,
  });
  repo.metadata.tableName = 'unrelated';
  await assert.rejects(
    core.prepareIntent(repo, 1, raw('prepared')),
    /Unsupported book intent storage/
  );
  repo.metadata.tableName = 'media_request';
  repo.manager.connection.options.type = 'mysql';
  await assert.rejects(
    core.prepareIntent(repo, 1, raw('prepared')),
    /Unsupported book intent storage/
  );
});
