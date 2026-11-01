/** Read-only Chaptarr Hardcover facade inventory. Never fall back to /book. */
export interface InventoryBook {
  id: number;
  foreignBookId: string;
  mediaType?: string;
  monitored?: boolean;
  statistics: { percentOfBooks: number; bookFileCount: number };
}
export type BookFormat = 'ebook' | 'audiobook';
export interface Inventory<T> {
  books: T[];
  uniqueBooks: T[];
  ambiguousWorkIds: number[];
  unmappedOwned: number;
  unmappedRelevant: number;
}
export interface PageRequest {
  params: Record<string, string | number | boolean>;
  timeout: number;
  maxContentLength: number;
  signal?: AbortSignal;
}
export type FetchPage = (
  path: string,
  request: PageRequest
) => Promise<unknown>;

// Fail fast instead of creating an unbounded queue on a single-threaded arr.
const activeInventories = new Set<string>();
export async function withChaptarrInventory<T>(
  origin: string,
  run: () => Promise<T>
): Promise<T> {
  if (activeInventories.has(origin))
    throw new Error('Chaptarr inventory busy; retry later');
  activeInventories.add(origin);
  try {
    return await run();
  } finally {
    activeInventories.delete(origin);
  }
}

export function hardcoverId(value: string): number | undefined {
  // The hc facade emits bare work IDs. Never reinterpret gr:/az:/edition IDs.
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** Select positive owners only; shared HC identities do not select a native row. */
export function partitionChaptarrPositives<T extends InventoryBook>(
  books: readonly T[],
  format: BookFormat
): { uniqueBooks: T[]; ambiguousWorkIds: number[] } {
  if (format !== 'ebook' && format !== 'audiobook')
    throw new Error('Invalid Chaptarr positive format');
  const nativeIds = new Set<number>();
  const groups = new Map<number, T[]>();
  for (const book of books) {
    const hcId = hardcoverId(book.foreignBookId);
    if (
      hcId === undefined ||
      !Number.isSafeInteger(book.id) ||
      book.id <= 0 ||
      nativeIds.has(book.id) ||
      book.mediaType !== format
    ) {
      throw new Error('Invalid or duplicate Chaptarr positive identity');
    }
    nativeIds.add(book.id);
    const group = groups.get(hcId) ?? [];
    group.push(book);
    groups.set(hcId, group);
  }
  const uniqueBooks: T[] = [];
  const ambiguousWorkIds: number[] = [];
  for (const [hcId, group] of groups) {
    if (group.length === 1) uniqueBooks.push(group[0]);
    else ambiguousWorkIds.push(hcId);
  }
  return { uniqueBooks, ambiguousWorkIds };
}

export async function loadChaptarrInventory<T extends InventoryBook>(
  fetchPage: FetchPage,
  format: BookFormat
): Promise<Inventory<T>> {
  const pageSize = 100;
  const maxRecords = 2000;
  const deadline = Date.now() + 60_000;
  const books = new Map<number, T>();
  // Sequential HTTP calls; no metadata fetch, author expansion or arr commands.
  for (const filter of ['downloaded', 'monitored']) {
    let offset = 0;
    let total: number | undefined;
    let previousId = 0;
    const seen = new Set<number>();
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error('Chaptarr inventory deadline exceeded');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let raw: unknown;
      try {
        raw = await fetchPage('/book/paged', {
          params: {
            offset,
            pageSize,
            sortKey: 'id',
            sortDirection: 'ASC',
            includeUnmonitored: true,
            [filter]: true,
          },
          timeout: Math.min(10_000, remaining),
          maxContentLength: 512 * 1024,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() > deadline)
        throw new Error('Chaptarr inventory deadline exceeded');
      if (!raw || typeof raw !== 'object')
        throw new Error('Invalid Chaptarr page');
      const page = raw as {
        totalCount: number;
        offset: number;
        pageSize: number;
        records: T[];
      };
      if (
        !Number.isSafeInteger(page.totalCount) ||
        page.totalCount < 0 ||
        page.totalCount > maxRecords ||
        page.offset !== offset ||
        page.pageSize !== pageSize ||
        !Array.isArray(page.records) ||
        page.records.length > pageSize ||
        (total !== undefined && total !== page.totalCount)
      ) {
        throw new Error('Incomplete or oversized Chaptarr inventory');
      }
      total = page.totalCount;
      if (page.records.length !== Math.min(pageSize, total - offset)) {
        throw new Error('Truncated Chaptarr inventory');
      }
      for (const book of page.records) {
        if (
          !Number.isSafeInteger(book.id) ||
          book.id <= previousId ||
          seen.has(book.id) ||
          book.mediaType !== format ||
          typeof book.foreignBookId !== 'string' ||
          !book.statistics ||
          !Number.isFinite(book.statistics.percentOfBooks) ||
          !Number.isSafeInteger(book.statistics.bookFileCount) ||
          book.statistics.bookFileCount < 0 ||
          book.statistics.percentOfBooks < 0 ||
          book.statistics.percentOfBooks > 100 ||
          (book.statistics.bookFileCount === 0 && !book.monitored) ||
          (filter === 'downloaded' && book.statistics.bookFileCount === 0)
        ) {
          throw new Error(
            'Invalid Chaptarr inventory identity, format or statistics'
          );
        }
        previousId = book.id;
        seen.add(book.id);
        const prior = books.get(book.id);
        if (
          prior &&
          (prior.foreignBookId !== book.foreignBookId ||
            prior.statistics.percentOfBooks !==
              book.statistics.percentOfBooks ||
            prior.statistics.bookFileCount !== book.statistics.bookFileCount)
        ) {
          throw new Error('Chaptarr inventory changed during pagination');
        }
        books.set(book.id, book);
        if (books.size > maxRecords)
          throw new Error('Chaptarr union exceeds record limit');
      }
      offset += page.records.length;
    } while (offset < total);
  }
  const all = [...books.values()];
  const mapped = all.filter(
    (book) => hardcoverId(book.foreignBookId) !== undefined
  );
  return {
    // Keep every mapped native row for duplicate-request refusal, including collisions.
    books: mapped,
    ...partitionChaptarrPositives(mapped, format),
    unmappedRelevant: all.filter(
      (book) => hardcoverId(book.foreignBookId) === undefined
    ).length,
    unmappedOwned: all.filter(
      (book) =>
        book.statistics.bookFileCount > 0 &&
        hardcoverId(book.foreignBookId) === undefined
    ).length,
  };
}

export function assertChaptarrRequestSafe<T extends InventoryBook>(
  inventory: Inventory<T>,
  hcId: number
): void {
  if (!Number.isSafeInteger(hcId) || hcId <= 0)
    throw new Error('Invalid Hardcover work ID');
  if (
    inventory.books.some((book) => hardcoverId(book.foreignBookId) === hcId)
  ) {
    throw new Error('This book is already owned or monitored in Chaptarr.');
  }
  if (inventory.unmappedRelevant > 0) {
    throw new Error(
      'Cannot safely request this book: owned or monitored Chaptarr books lack Hardcover IDs.'
    );
  }
}
