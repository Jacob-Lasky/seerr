import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  DataSource,
  EntityNotFoundError,
  EntitySchema,
  TableColumn,
} from 'typeorm';
net.Socket.prototype.connect = () => assert.fail('network forbidden');
globalThis.fetch = async () => assert.fail('network forbidden');
const root = process.cwd();
const migrationRoot = process.env.W98_MIGRATION_TREE ?? root;
const source = (path, tree = root) => readFileSync(resolve(tree, path), 'utf8');
function migration() {
  const code = stripTypeScriptTypes(
    source(
      'server/migration/sqlite/1793534400000-BookRequestIntent.ts',
      migrationRoot
    ),
    { mode: 'transform' }
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export class', 'class');
  return new (new Function(
    'TableColumn',
    code + '; return BookRequestIntent1793534400000;'
  )(TableColumn))();
}
class Media {}
class User {
  hasPermission() {
    return false;
  }
  filter() {
    return { id: this.id };
  }
}
class Request {}
const mediaSchema = new EntitySchema({
  name: 'Media',
  target: Media,
  tableName: 'media',
  columns: { id: { type: Number, primary: true }, status: { type: Number } },
});
const userSchema = new EntitySchema({
  name: 'User',
  target: User,
  tableName: 'user',
  columns: { id: { type: Number, primary: true } },
  relations: {
    requests: {
      type: 'one-to-many',
      target: () => Request,
      inverseSide: 'requestedBy',
    },
  },
});
const requestSchema = new EntitySchema({
  name: 'Request',
  target: Request,
  tableName: 'media_request',
  columns: {
    id: { type: Number, primary: true },
    status: { type: Number },
    bookRequestIntent: { type: 'text', nullable: true },
  },
  relations: {
    media: {
      type: 'many-to-one',
      target: () => Media,
      joinColumn: true,
      onDelete: 'CASCADE',
    },
    requestedBy: {
      type: 'many-to-one',
      target: () => User,
      inverseSide: 'requests',
      joinColumn: true,
      onDelete: 'CASCADE',
    },
  },
});
async function fixture(raw = '{"state":"unknown"}', database = ':memory:') {
  const db = await new DataSource({
    type: 'sqlite',
    database,
    entities: [mediaSchema, userSchema, requestSchema],
  }).initialize();
  await db.query(
    'CREATE TABLE media(id integer PRIMARY KEY, status integer NOT NULL)'
  );
  await db.query('CREATE TABLE user(id integer PRIMARY KEY)');
  await db.query(
    'CREATE TABLE media_request(id integer PRIMARY KEY, status integer NOT NULL, mediaId integer REFERENCES media(id) ON DELETE CASCADE, requestedById integer REFERENCES user(id) ON DELETE CASCADE)'
  );
  const m = migration();
  await m.up(db.createQueryRunner());
  await db.getRepository(Media).save({ id: 8, status: 3 });
  await db.getRepository(User).save({ id: 2 });
  await db.getRepository(Request).save({
    id: 1,
    status: 2,
    media: { id: 8 },
    requestedBy: { id: 2 },
    bookRequestIntent: raw,
  });
  return {
    db,
    m,
    async close() {
      await db.destroy();
    },
  };
}
function handler(kind, db) {
  let fn;
  const register = {
    delete: (_path, _auth, f) => {
      fn = f;
    },
  };
  const text = source(
    kind === 'media' ? 'server/routes/media.ts' : 'server/routes/user/index.ts'
  );
  const start = text.indexOf(
    kind === 'media' ? 'mediaRoutes.delete(' : 'router.delete<{ id: string }>('
  );
  assert.notEqual(start, -1);
  const end = text.indexOf(
    kind === 'media' ? 'mediaRoutes.delete(' : 'router.post(',
    start + 1
  );
  const code = stripTypeScriptTypes(text.slice(start, end), {
    mode: 'transform',
  });
  const bindings = {
    mediaRoutes: register,
    router: register,
    isAuthenticated: () => () => {},
    Permission: { MANAGE_REQUESTS: 1, MANAGE_USERS: 2, ADMIN: 4 },
    getRepository: (target) => db.getRepository(target),
    Media,
    MediaRequest: Request,
    User,
    MediaStatus: { BLOCKLISTED: 7 },
    EntityNotFoundError,
    logger: { error() {} },
  };
  new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  assert.equal(typeof fn, 'function');
  return fn;
}
async function invoke(fn, id) {
  const result = { status: undefined, errors: [] };
  const res = {
    status(n) {
      result.status = n;
      return this;
    },
    send() {},
    json() {},
  };
  await fn({ params: { id: String(id) }, user: { id: 1 } }, res, (e) =>
    result.errors.push(e)
  );
  return result;
}
for (const state of [
  'prepared',
  'sending',
  'accepted_pending',
  'unknown',
  'refused',
  'native_linked',
  'malformed',
]) {
  for (const kind of ['media', 'user']) {
    test(`database holds actual ${kind} removal for ${state} admission`, async () => {
      const raw = state === 'malformed' ? '' : JSON.stringify({ state });
      const f = await fixture(raw);
      try {
        const result = await invoke(
          handler(kind, f.db),
          kind === 'media' ? 8 : 2
        );
        const remaining = await f.db
          .getRepository(Request)
          .findOneBy({ id: 1 });
        assert.ok(
          remaining,
          'actual removal must retain sole durable admission'
        );
        assert.equal(remaining.bookRequestIntent, raw);
        assert.equal(await f.db.getRepository(Media).count(), 1);
        assert.equal(await f.db.getRepository(User).count(), 1);
        assert.equal(
          result.errors.length,
          1,
          'existing caller must report refusal, not deletion success'
        );
      } finally {
        await f.close();
      }
    });
  }
}
for (const kind of ['media', 'user']) {
  test(`actual ${kind} removal still deletes NULL-intent stock request`, async () => {
    const f = await fixture(null);
    try {
      const result = await invoke(
        handler(kind, f.db),
        kind === 'media' ? 8 : 2
      );
      assert.deepEqual(result.errors, []);
      assert.equal(result.status, kind === 'media' ? 204 : 200);
      assert.equal(await f.db.getRepository(Request).count(), 0);
    } finally {
      await f.close();
    }
  });
}
for (const action of ['remove', 'delete', 'parent-user-cascade']) {
  test(`database holds ORM ${action} independently of HTTP guards`, async () => {
    const f = await fixture();
    try {
      const repo = f.db.getRepository(Request);
      await repo.save({
        id: 2,
        status: 2,
        media: { id: 8 },
        requestedBy: { id: 2 },
        bookRequestIntent: null,
      });
      const command = () =>
        action === 'remove'
          ? repo.remove([repo.create({ id: 2 }), repo.create({ id: 1 })])
          : action === 'delete'
            ? repo.delete([2, 1])
            : f.db.getRepository(User).delete(2);
      await assert.rejects(command, /BOOK_REQUEST_INTENT_DELETE_HELD/);
      assert.equal(
        (await repo.findOneByOrFail({ id: 1 })).bookRequestIntent,
        '{"state":"unknown"}'
      );
      assert.equal(
        await repo.count(),
        2,
        'ordinary peer deletion rolls back with held bulk operation'
      );
    } finally {
      await f.close();
    }
  });
}
test('prepare first atomically holds parent delete; delete first prevents later preparation/claim', async () => {
  for (const first of ['prepare', 'delete']) {
    const f = await fixture(null);
    try {
      const repo = f.db.getRepository(Request);
      const prepare = () =>
        repo
          .createQueryBuilder()
          .update()
          .set({ bookRequestIntent: '{"state":"prepared"}' })
          .where('id = 1 AND bookRequestIntent IS NULL')
          .execute();
      if (first === 'prepare') {
        assert.equal((await prepare()).affected, 1);
        await assert.rejects(
          () => f.db.getRepository(Media).delete(8),
          /BOOK_REQUEST_INTENT_DELETE_HELD/
        );
        assert.equal(await repo.count(), 1);
      } else {
        await f.db.getRepository(Media).delete(8);
        assert.equal((await prepare()).affected, 0);
        assert.equal(await repo.count(), 0);
      }
    } finally {
      await f.close();
    }
  }
});
test('intent preparation rollback does not leave a false deletion hold', async () => {
  const f = await fixture(null);
  try {
    await assert.rejects(
      () =>
        f.db.transaction(async (manager) => {
          await manager
            .getRepository(Request)
            .update(1, { bookRequestIntent: '{"state":"prepared"}' });
          throw new Error('synthetic rollback');
        }),
      /synthetic rollback/
    );
    await f.db.getRepository(Media).delete(8);
    assert.equal(await f.db.getRepository(Request).count(), 0);
  } finally {
    await f.close();
  }
});
test('schema rollback cannot erase admission history; NULL-only rollback remains supported', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.m.down(f.db.createQueryRunner()),
      /BOOK_REQUEST_INTENT_ROLLBACK_HELD/
    );
    assert.equal(
      (await f.db.getRepository(Request).findOneByOrFail({ id: 1 }))
        .bookRequestIntent,
      '{"state":"unknown"}'
    );
    await assert.rejects(
      () => f.db.getRepository(Media).delete(8),
      /BOOK_REQUEST_INTENT_DELETE_HELD/
    );
  } finally {
    await f.close();
  }
  const clean = await fixture(null);
  try {
    await clean.m.down(clean.db.createQueryRunner());
    assert.equal(
      (await clean.db.query('PRAGMA table_info(media_request)')).some(
        (c) => c.name === 'bookRequestIntent'
      ),
      false
    );
  } finally {
    await clean.close();
  }
});

test('independent SQLite deletion cannot cross an uncommitted preparation writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w98-delete-race-'));
  const file = join(dir, 'fixture.sqlite');
  const f = await fixture(null, file);
  const other = await new DataSource({
    type: 'sqlite',
    database: file,
    entities: [mediaSchema, userSchema, requestSchema],
  }).initialize();
  const runner = f.db.createQueryRunner();
  try {
    await other.query('PRAGMA busy_timeout=25');
    await runner.startTransaction();
    await runner.manager
      .getRepository(Request)
      .update(1, { bookRequestIntent: '{"state":"prepared"}' });
    await assert.rejects(
      () => other.getRepository(Media).delete(8),
      /SQLITE_BUSY/
    );
    await runner.commitTransaction();
    await assert.rejects(
      () => other.getRepository(Media).delete(8),
      /BOOK_REQUEST_INTENT_DELETE_HELD/
    );
    assert.equal(
      (await other.getRepository(Request).findOneByOrFail({ id: 1 }))
        .bookRequestIntent,
      '{"state":"prepared"}'
    );
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    await other.destroy();
    await f.close();
    await rm(dir, { recursive: true });
  }
});

test('actual user bulk removal rolls back ordinary peers when one admission is held', async () => {
  const f = await fixture();
  try {
    const repo = f.db.getRepository(Request);
    await repo.save({
      id: 2,
      status: 1,
      media: { id: 8 },
      requestedBy: { id: 2 },
      bookRequestIntent: null,
    });
    const before = await f.db.query('SELECT * FROM media_request ORDER BY id');
    const result = await invoke(handler('user', f.db), 2);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(
      await f.db.query('SELECT * FROM media_request ORDER BY id'),
      before
    );
    assert.equal(await f.db.getRepository(User).count(), 1);
  } finally {
    await f.close();
  }
});
