import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type {
  FetchPage,
  InventoryBook,
  PageRequest,
} from './chaptarrInventory';
import {
  assertChaptarrRequestSafe,
  hardcoverId,
  loadChaptarrInventory,
  partitionChaptarrPositives,
  withChaptarrInventory,
} from './chaptarrInventory';

const book = (id: number, hc = String(id), format = 'ebook', owned = true) => ({
  id,
  foreignBookId: hc,
  mediaType: format,
  monitored: true,
  statistics: { bookFileCount: owned ? 1 : 0, percentOfBooks: owned ? 100 : 0 },
});
function transport(owned: InventoryBook[], monitored: InventoryBook[]) {
  const calls: { path: string; request: PageRequest }[] = [];
  let active = 0;
  let maxActive = 0;
  const fetch: FetchPage = async (path, request) => {
    calls.push({ path, request });
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    assert.equal(path, '/book/paged');
    const rows = request.params.downloaded ? owned : monitored;
    const offset = Number(request.params.offset);
    active--;
    return {
      offset,
      pageSize: 100,
      totalCount: rows.length,
      records: rows.slice(offset, offset + 100),
    };
  };
  return { fetch, calls, concurrency: () => maxActive };
}

type FixturePage = {
  offset: number;
  pageSize: number;
  totalCount: number;
  records: InventoryBook[];
};

describe('Chaptarr inventory', () => {
  it('pages owned and monitored separately, deduplicates, never loads full catalogue', async () => {
    const t = transport(
      Array.from({ length: 101 }, (_, i) => book(i + 1)),
      [book(1), book(102, '102', 'ebook', false)]
    );
    const result = await loadChaptarrInventory(t.fetch, 'ebook');
    assert.equal(result.books.length, 102);
    assert.deepEqual(
      t.calls.map((c) => c.request.params.offset),
      [0, 100, 0]
    );
    assert.equal(t.concurrency(), 1);
    for (const c of t.calls) {
      assert.equal(c.request.params.sortKey, 'id');
      assert.equal(c.request.params.includeUnmonitored, true);
      assert.equal(c.request.maxContentLength, 524288);
      assert.ok(c.request.timeout <= 10000);
      assert.ok(c.request.signal instanceof AbortSignal);
    }
  });
  it('does not drop owned but unmonitored books', async () => {
    const t = transport([{ ...book(1), monitored: false }], []);
    assert.equal(
      (await loadChaptarrInventory(t.fetch, 'ebook')).books.length,
      1
    );
  });
  it('keeps audiobook format and owned statistics', async () => {
    const t = transport(
      [book(1, '427381', 'audiobook')],
      [book(1, '427381', 'audiobook')]
    );
    const r = await loadChaptarrInventory(t.fetch, 'audiobook');
    assert.equal(r.books[0].statistics.percentOfBooks, 100);
    assert.equal(r.books[0].foreignBookId, '427381');
  });
  it('does not coerce provider, edition, partial, unsafe or zero IDs', () => {
    for (const id of [
      'gr:12',
      'hc:12',
      'az:12',
      '12-ebook',
      '',
      '0',
      '12x',
      '9007199254740992',
    ])
      assert.equal(hardcoverId(id), undefined);
    assert.equal(hardcoverId('123'), 123);
  });
  it('imports recognized ownership but blocks ambiguous NEW requests without writing', async () => {
    const t = transport([book(1, '123'), book(2, '')], []);
    const r = await loadChaptarrInventory(t.fetch, 'ebook');
    assert.equal(r.books.length, 1);
    assert.equal(r.unmappedOwned, 1);
    assert.throws(() => assertChaptarrRequestSafe(r, 123), /already owned/);
    assert.throws(() => assertChaptarrRequestSafe(r, 999), /lack Hardcover/);
  });
  it('also blocks ambiguous monitored-only aliases', async () => {
    const t = transport([], [book(1, '', 'ebook', false)]);
    const r = await loadChaptarrInventory(t.fetch, 'ebook');
    assert.equal(r.unmappedOwned, 0);
    assert.equal(r.unmappedRelevant, 1);
    assert.throws(() => assertChaptarrRequestSafe(r, 999), /lack Hardcover/);
  });
  it('permits a new ID only with a complete recognized inventory', async () => {
    const t = transport([book(1, '123')], []);
    const r = await loadChaptarrInventory(t.fetch, 'ebook');
    assert.doesNotThrow(() => assertChaptarrRequestSafe(r, 999));
  });
  for (const [label, transform] of [
    ['truncated', (p: FixturePage) => ({ ...p, records: [] })],
    [
      'wrong format',
      (p: FixturePage) => ({ ...p, records: [book(1, '1', 'audiobook')] }),
    ],
    [
      'missing statistics',
      (p: FixturePage) => ({
        ...p,
        records: [{ ...book(1), statistics: undefined }],
      }),
    ],
    ['oversized count', (p: FixturePage) => ({ ...p, totalCount: 2001 })],
    ['wrong offset', (p: FixturePage) => ({ ...p, offset: 100 })],
    [
      'duplicate local ID',
      (p: FixturePage) => ({
        ...p,
        totalCount: 2,
        records: [book(1), book(1)],
      }),
    ],
  ] as const) {
    it('fails closed on ' + label + ' without fallback', async () => {
      const t = transport([book(1)], []);
      await assert.rejects(
        loadChaptarrInventory(
          async (path, request) =>
            transform((await t.fetch(path, request)) as FixturePage),
          'ebook'
        )
      );
      assert.equal(t.calls.length, 1);
    });
  }
  it('rejects changing totals during pagination', async () => {
    const t = transport(
      Array.from({ length: 101 }, (_, i) => book(i + 1)),
      []
    );
    await assert.rejects(
      loadChaptarrInventory(async (path, request) => {
        const p = (await t.fetch(path, request)) as FixturePage;
        return request.params.offset ? { ...p, totalCount: 102 } : p;
      }, 'ebook'),
      /Incomplete/
    );
  });
  it('propagates timeout or HTTP failure without full-list fallback', async () => {
    const calls: string[] = [];
    await assert.rejects(
      loadChaptarrInventory(async (path) => {
        calls.push(path);
        throw new Error('timeout');
      }, 'ebook'),
      /timeout/
    );
    assert.deepEqual(calls, ['/book/paged']);
  });
  it('accepts empty inventory without catalogue fallback', async () => {
    const t = transport([], []);
    const r = await loadChaptarrInventory(t.fetch, 'ebook');
    assert.equal(r.books.length, 0);
    assert.equal(t.calls.length, 2);
  });
  it('rejects disagreeing ownership between the two filter streams', async () => {
    const t = transport([book(1)], [book(1, '999')]);
    await assert.rejects(
      loadChaptarrInventory(t.fetch, 'ebook'),
      /changed during/
    );
  });
  it('caps the deduplicated union even when each stream fits', async () => {
    const t = transport(
      Array.from({ length: 1001 }, (_, i) => book(i + 1)),
      Array.from({ length: 1001 }, (_, i) => book(i + 1002))
    );
    await assert.rejects(
      loadChaptarrInventory(t.fetch, 'ebook'),
      /union exceeds/
    );
  });
  it('rejects a late page instead of accepting a partial snapshot', async () => {
    const originalNow = Date.now;
    let clock = originalNow();
    Date.now = () => clock;
    try {
      const t = transport([book(1)], []);
      await assert.rejects(
        loadChaptarrInventory(async (path, request) => {
          const page = await t.fetch(path, request);
          clock += 61000;
          return page;
        }, 'ebook'),
        /deadline/
      );
      assert.equal(t.calls.length, 1);
    } finally {
      Date.now = originalNow;
    }
  });
  it('rejects overlapping inventories without queueing and releases on failure', async () => {
    let finish: (() => void) | undefined;
    const first = withChaptarrInventory(
      'http://fixture.invalid',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await assert.rejects(
      withChaptarrInventory('http://fixture.invalid', async () => 1),
      /busy/
    );
    finish!();
    await first;
    await assert.rejects(
      withChaptarrInventory('http://fixture.invalid', async () => {
        throw new Error('fixture failure');
      })
    );
    assert.equal(
      await withChaptarrInventory('http://fixture.invalid', async () => 7),
      7
    );
  });
  it('rejects irrelevant catalogue rows even if paging filter is ignored', async () => {
    const t = transport(
      [{ ...book(1, '1', 'ebook', false), monitored: false }],
      []
    );
    await assert.rejects(loadChaptarrInventory(t.fetch, 'ebook'), /statistics/);
  });
  it('guards the entity BEFORE the first media save', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'server/entity/MediaRequest.ts'),
      'utf8'
    );
    const guard = source.indexOf('await api.assertBookRequestSafe');
    assert.ok(guard >= 0, 'instrument must find the actual guard');
    assert.ok(guard < source.indexOf('await mediaRepository.save'));
    assert.ok(source.includes('No matching book-format server is configured.'));
  });
});

describe('Chaptarr positive ownership partition', () => {
  for (const format of ['ebook', 'audiobook'] as const) {
    it(`${format}: retains all native rows for refusal but selects no ambiguous owner`, async () => {
      const rows = [
        book(11, '900', format),
        book(12, '900', format),
        book(13, '901', format),
      ];
      const t = transport(rows, [rows[0]]);
      const r = await loadChaptarrInventory(t.fetch, format);
      assert.deepEqual(
        r.books.map((b) => b.id),
        [11, 12, 13]
      );
      assert.deepEqual(
        r.uniqueBooks.map((b) => b.id),
        [13]
      );
      assert.deepEqual(r.ambiguousWorkIds, [900]);
      assert.equal(r.unmappedRelevant, 0);
      assert.throws(() => assertChaptarrRequestSafe(r, 900), /already owned/);
      // Permuting distinct native rows must never select either collision member.
      const reverse = partitionChaptarrPositives(
        [...r.books].reverse(),
        format
      );
      assert.deepEqual(
        reverse.uniqueBooks.map((b) => b.id),
        [13]
      );
      assert.deepEqual(reverse.ambiguousWorkIds, [900]);
      assert.deepEqual(
        r.books,
        rows,
        'partition does not merge or rewrite upstream works'
      );
    });
    it(`${format}: repeated native row across streams is unique and missing aliases remain guarded`, async () => {
      const t = transport(
        [book(1, '900', format)],
        [book(1, '900', format), book(2, '', format, false)]
      );
      const r = await loadChaptarrInventory(t.fetch, format);
      assert.deepEqual(
        r.uniqueBooks.map((b) => b.id),
        [1]
      );
      assert.deepEqual(r.ambiguousWorkIds, []);
      assert.equal(r.unmappedRelevant, 1);
      assert.equal(r.unmappedOwned, 0);
      assert.throws(() => assertChaptarrRequestSafe(r, 901), /lack Hardcover/);
    });
  }
  it('helper rejects invalid work, native and format identities independently', () => {
    for (const foreignBookId of [
      'hc:12',
      'gr:12',
      'az:12',
      '12-ebook',
      '',
      '0',
      '9007199254740992',
      12 as unknown as string,
    ]) {
      assert.throws(
        () =>
          partitionChaptarrPositives([{ ...book(1), foreignBookId }], 'ebook'),
        /identity/
      );
    }
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => partitionChaptarrPositives([book(id)], 'ebook'),
        /identity/
      );
    }
    assert.throws(
      () => partitionChaptarrPositives([book(1, '12', 'audiobook')], 'ebook'),
      /identity/
    );
    assert.throws(
      () => partitionChaptarrPositives([], 'comic' as 'ebook'),
      /format/
    );
  });
  it('helper refuses even identical repeated native IDs instead of silently dropping rows', () => {
    assert.throws(
      () => partitionChaptarrPositives([book(1), book(1)], 'ebook'),
      /duplicate/
    );
    assert.throws(
      () => partitionChaptarrPositives([book(1), book(1, '999')], 'ebook'),
      /duplicate/
    );
    assert.throws(
      () =>
        partitionChaptarrPositives(
          [
            book(1),
            {
              ...book(1),
              statistics: { bookFileCount: 2, percentOfBooks: 50 },
            },
          ],
          'ebook'
        ),
      /duplicate/
    );
  });
  it('pagination rejects cross-stream ownership drift before producing positive groups', async () => {
    const t = transport(
      [book(1)],
      [{ ...book(1), statistics: { bookFileCount: 2, percentOfBooks: 50 } }]
    );
    await assert.rejects(
      loadChaptarrInventory(t.fetch, 'ebook'),
      /changed during/
    );
  });
  it('ebook and audiobook positives remain distinct format inventories', () => {
    const ebook = partitionChaptarrPositives(
      [book(1, '900', 'ebook')],
      'ebook'
    );
    const audio = partitionChaptarrPositives(
      [book(2, '900', 'audiobook')],
      'audiobook'
    );
    assert.equal(ebook.uniqueBooks[0].id, 1);
    assert.equal(audio.uniqueBooks[0].id, 2);
  });
});
