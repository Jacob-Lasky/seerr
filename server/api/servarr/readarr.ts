import type { BookRequestIntent } from '@server/lib/bookRequestIntent';
import { positiveId, wireField } from '@server/lib/bookRequestIntent';
import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import ServarrBase from './base';
import type { BookFormat } from './chaptarrInventory';
import {
  assertChaptarrRequestSafe,
  hardcoverId,
  loadChaptarrInventory,
  withChaptarrInventory,
} from './chaptarrInventory';

export interface MetadataProfile {
  id: number;
  name: string;
  minPopularity: number;
  skipMissingDate: boolean;
  skipMissingIsbn: boolean;
  skipPartsAndSets: boolean;
  skipSeriesSecondary: boolean;
  allowedLanguages: string;
  minPages: number;
  ignored: string[];
}

export interface ReadarrBookOptions {
  title: string;
  qualityProfileId: number;
  metadataProfileId: number;
  tags: number[];
  profileId: number;
  rootFolderPath: string;
  hcId: number;
  authorHcId: number;
  monitored?: boolean;
  searchNow?: boolean;
}

export interface ReadarrBook {
  mediaType?: string;
  id: number;
  title: string;
  authorTitle: string;
  seriesTitle: string;
  disambiguation: string;
  authorId: number;
  foreignBookId: string;
  foreignEditionId: string;
  titleSlug: string;
  monitored: boolean;
  anyEditionOk: boolean;
  author?: object;
  edition?: object;
  ratings: {
    votes: number;
    value: number;
    popularity: number;
  };
  releaseDate: string;
  pageCount: number;
  genres: string[];
  images: {
    url: string;
    coverType: string;
    extension: string;
  }[];
  links: {
    url: string;
    name: string;
  }[];
  added: string;
  remoteCover: string;
  grabbed: boolean;
  statistics: {
    bookFileCount: number;
    bookCount: number;
    totalBookCount: number;
    sizeOnDisk: number;
    percentOfBooks: number;
  };
}

interface ReadarrEdition {
  bookId: number;
  foreignEditionId: string;
  titleSlug: string;
  asin: string;
  title: string;
  language: string;
  overview: string;
  format: string;
  isEbook: boolean;
  disambiguation: string;
  publisher: string;
  pageCount: number;
  releaseDate: string;
  images: {
    url: string;
    coverType: string;
    extension: string;
  }[];
  links: {
    url: string;
    name: string;
  }[];
  ratings: {
    votes: number;
    value: number;
    popularity: number;
  };
  monitored: boolean;
  manualAdd: boolean;
  grabbed: boolean;
  id: number;
  isbn13?: string;
}

class ReadarrAPI extends ServarrBase<{ bookId: number }> {
  private readonly chaptarrFormat?: BookFormat;
  public inventoryComplete = true;
  private readonly inventoryOrigin: string;

  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'readarr', apiName: 'Readarr' });
    this.inventoryOrigin = new URL(url).origin;
    const match = new URL(url).pathname.match(
      /\/readarr\/hc\/(ebook|audiobook)\/api\/v1\/?$/
    );
    this.chaptarrFormat = match?.[1] as BookFormat | undefined;
  }

  public get requestIntentFormat(): BookFormat | undefined {
    return this.chaptarrFormat;
  }

  /** Single bounded POST, no retry interceptor, redirects or cache. Job-only. */
  public async postBookRequestIntent(
    payload: string
  ): Promise<{ status: number; data: unknown }> {
    if (!this.chaptarrFormat) throw new Error('Chaptarr facade required');
    const response = await this.axios.post('/book', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
      maxRedirects: 0,
      maxContentLength: 65536,
      maxBodyLength: 32768,
      validateStatus: () => true,
    });
    return { status: response.status, data: response.data };
  }

  /** Inventory misses are not absence authority; the producer owns identity admission. */
  public async getIntentPositive(
    intent: BookRequestIntent
  ): Promise<ReadarrBook | undefined> {
    if (intent.format !== this.chaptarrFormat)
      throw new Error('Intent facade mismatch');
    const inventory = await this.loadChaptarrInventory();
    if (inventory.unmappedRelevant > 0 || inventory.ambiguousWorkIds.length > 0)
      throw new Error('Intent inventory is incomplete or ambiguous');
    const matches = inventory.uniqueBooks.filter(
      (b) => hardcoverId(b.foreignBookId) === intent.workId
    );
    if (matches.length > 1) throw new Error('Intent work is ambiguous');
    return matches.length === 1 ? matches[0] : undefined;
  }

  public async verifyIntentNative(
    id: number,
    intent: BookRequestIntent
  ): Promise<ReadarrBook> {
    if (!positiveId(id) || intent.format !== this.chaptarrFormat)
      throw new Error('Book intent native format mismatch');
    const data = (
      await this.axios.get(`/book/${id}`, {
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: 262144,
      })
    ).data;
    const nativeId = wireField(data, 'id', 'Id');
    const work = wireField(data, 'foreignBookId', 'ForeignBookId');
    const format = wireField(data, 'mediaType', 'MediaType');
    const slug = wireField(data, 'titleSlug', 'TitleSlug');
    const authorId = wireField(data, 'authorId', 'AuthorId');
    if (
      nativeId !== id ||
      typeof work !== 'string' ||
      hardcoverId(work) !== intent.workId ||
      format !== intent.format ||
      typeof slug !== 'string' ||
      !slug ||
      !positiveId(authorId)
    )
      throw new Error('Book intent fresh native identity mismatch');
    // Native author id is not an HC author id. Verify its separate resource.
    const author = (
      await this.axios.get(`/author/${authorId}`, {
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: 262144,
      })
    ).data;
    const foreignAuthor = wireField(
      author,
      'foreignAuthorId',
      'ForeignAuthorId'
    );
    if (
      wireField(author, 'id', 'Id') !== authorId ||
      typeof foreignAuthor !== 'string' ||
      hardcoverId(foreignAuthor) !== intent.authorId
    )
      throw new Error('Book intent author identity mismatch');
    return { ...data, id, titleSlug: slug } as ReadarrBook;
  }

  public getMetadataProfiles = async (): Promise<MetadataProfile[]> => {
    try {
      const data = await this.getRolling<MetadataProfile[]>(
        `/metadataprofile`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[Readarr] Failed to retrieve metadata profiles: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getBooks = async (): Promise<ReadarrBook[]> => {
    try {
      if (this.chaptarrFormat) {
        const inventory = await this.loadChaptarrInventory();
        this.inventoryComplete =
          inventory.unmappedRelevant === 0 &&
          inventory.ambiguousWorkIds.length === 0;
        if (!this.inventoryComplete) {
          logger.warn(
            'Unmapped or ambiguous Chaptarr books were excluded from availability.',
            {
              label: 'Readarr',
              owned: inventory.unmappedOwned,
              relevant: inventory.unmappedRelevant,
              ambiguous: inventory.ambiguousWorkIds.length,
            }
          );
        }
        return inventory.uniqueBooks;
      }
      const data = await this.get<ReadarrBook[]>('/book');

      return data;
    } catch (e) {
      throw new Error(`[Readarr] Failed to retrieve books: ${e.message}`, {
        cause: e,
      });
    }
  };

  public isBookFullyDownloaded = (book: ReadarrBook): boolean =>
    book.statistics?.percentOfBooks >= 100 &&
    (!this.chaptarrFormat || book.statistics?.bookFileCount > 0);

  private loadChaptarrInventory = () => {
    if (!this.chaptarrFormat) throw new Error('Chaptarr facade is required');
    return withChaptarrInventory(this.inventoryOrigin, () =>
      loadChaptarrInventory<ReadarrBook>(
        (path, request) =>
          this.axios.get(path, request).then((response) => response.data),
        this.chaptarrFormat!
      )
    );
  };

  public assertBookRequestSafe = async (hcId: number): Promise<void> => {
    // Stock Readarr is unchanged. Only explicit hc format facades use this contract.
    if (this.chaptarrFormat) {
      assertChaptarrRequestSafe(await this.loadChaptarrInventory(), hcId);
      // This is a safety veto, NOT an absence proof. Only the durable explicit
      // request-intent job may submit a producer-owned add after this check.
    }
  };

  public getBook = async (id: number): Promise<ReadarrBook> => {
    try {
      const data = await this.get<ReadarrBook>(`/book/${id}`);

      return data;
    } catch (e) {
      throw new Error(`[Readarr] Failed to retrieve book: ${e.message}`, {
        cause: e,
      });
    }
  };

  private selectChaptarrPositive(
    books: ReadarrBook[],
    hcId: number
  ): ReadarrBook {
    if (!Number.isSafeInteger(hcId) || hcId <= 0) {
      throw new Error('Invalid Hardcover work ID');
    }
    const matches = books.filter(
      (book) => hardcoverId(book.foreignBookId) === hcId
    );
    if (matches.length !== 1) {
      throw new Error(
        'Chaptarr existing identity is unknown or ambiguous; not proof of absence.'
      );
    }
    return matches[0];
  }

  /** Undefined means stock Readarr only. Facade uncertainty always throws. */
  public async getExistingChaptarrBookForReconciliation(
    hcId: number,
    searchRequested = false,
    expectedFormat?: BookFormat
  ): Promise<ReadarrBook | undefined> {
    if (!this.chaptarrFormat) return undefined;
    if (
      expectedFormat !== undefined &&
      expectedFormat !== this.chaptarrFormat
    ) {
      throw new Error('Chaptarr facade format does not match this request.');
    }
    if (searchRequested)
      throw new Error('Chaptarr search is not a read-only reconciliation.');
    const inventory = await this.loadChaptarrInventory();
    if (
      inventory.unmappedRelevant > 0 ||
      inventory.ambiguousWorkIds.length > 0
    ) {
      throw new Error(
        'Chaptarr reconciliation requires unambiguous mapped relevant inventory.'
      );
    }
    const book = this.selectChaptarrPositive(inventory.uniqueBooks, hcId);
    // ExternalAPI.get may return a cached record even with ttl=0.
    const current = (await this.axios.get<ReadarrBook>(`/book/${book.id}`))
      .data;
    if (
      !current ||
      current.id !== book.id ||
      hardcoverId(current.foreignBookId) !== hcId ||
      current.mediaType !== this.chaptarrFormat ||
      typeof current.monitored !== 'boolean' ||
      current.monitored !== book.monitored ||
      !current.statistics ||
      current.statistics.bookFileCount !== book.statistics.bookFileCount ||
      current.statistics.percentOfBooks !== book.statistics.percentOfBooks ||
      typeof current.titleSlug !== 'string' ||
      current.titleSlug.length === 0 ||
      (!current.monitored && !this.isBookFullyDownloaded(current))
    ) {
      throw new Error(
        'Chaptarr native identity or existing state changed; reconciliation refused.'
      );
    }
    return current;
  }

  public async getBookByHcId(id: number): Promise<ReadarrBook> {
    if (this.chaptarrFormat) {
      const inventory = await this.loadChaptarrInventory();
      return this.selectChaptarrPositive(inventory.uniqueBooks, id);
    }
    let response: AxiosResponse<ReadarrBook[]>;
    try {
      response = await this.axios.get<ReadarrBook[]>('/book/lookup', {
        params: { term: `work:${id}` },
      });
    } catch (e) {
      logger.error('Error retrieving book by ID', {
        label: 'Readarr API',
        errorMessage: e.message,
        hcId: id,
      });
      throw e;
    }

    if (!response.data[0]) {
      throw new Error('Book not found');
    }

    return response.data[0];
  }

  public getEditions = async (id: number): Promise<ReadarrEdition[]> => {
    try {
      const response = await this.get<ReadarrEdition[]>(`/edition`, {
        params: { bookId: id },
      });

      return response;
    } catch (e) {
      throw new Error(`[Readarr] Failed to retrieve book: ${e.message}`, {
        cause: e,
      });
    }
  };

  public addBook = async (
    options: ReadarrBookOptions
  ): Promise<ReadarrBook> => {
    if (this.chaptarrFormat) {
      // Existing-state no-op only: never import, repair editions, tag, or search.
      const existing = await this.getExistingChaptarrBookForReconciliation(
        options.hcId,
        options.searchNow
      );
      if (!existing) throw new Error('Chaptarr existing identity is required.');
      return existing;
    }
    try {
      const newAuthorId = options.authorHcId.toString();
      const book = await this.getBookByHcId(options.hcId);

      if (book.grabbed) {
        logger.info(
          'Book already exists and is available. Skipping add and returning success',
          {
            label: 'Readarr',
            book: book,
          }
        );
        return book;
      }

      // book exists in Readarr but is neither downloaded nor monitored
      if (book.id && !book.monitored) {
        const bookData = await this.getBook(book.id);
        const editionData = await this.getEditions(book.id);
        const response = await this.axios.put<ReadarrBook>(`/book`, {
          ...bookData,
          monitored: true,
          author: {
            ...bookData.author,
            qualityProfileId: options.qualityProfileId,
            metadataProfileId: options.metadataProfileId,
            tags: options.tags,
            rootFolderPath: options.rootFolderPath,
          },
          editions: editionData.map((edition) => ({
            ...edition,
            monitored: edition.foreignEditionId === book.foreignEditionId,
          })),
          addOptions: {
            searchForNewBook: options.searchNow,
          },
        });
        const data = response.data;

        if (data.monitored) {
          logger.info(
            'Found existing book in Readarr and set it to monitored.',
            {
              label: 'Readarr',
              bookId: data.id,
              bookTitle: data.title,
            }
          );
          logger.debug('Readarr update details', {
            label: 'Readarr',
            book: data,
          });

          if (options.searchNow) {
            this.searchBook(data.id);
          }

          return data;
        } else {
          logger.error('Failed to update existing book in Readarr.', {
            label: 'Readarr',
            options,
          });
          throw new Error('Failed to update existing book in Readarr');
        }
      }

      if (book.id) {
        logger.info(
          'Book is already monitored in Readarr. Skipping add and returning success',
          { label: 'Readarr' }
        );
        if (options.searchNow) {
          this.searchBook(book.id);
        }
        return book;
      }

      const data = await this.post<ReadarrBook>(`/book`, {
        authorId: 0,
        foreignBookId: book.foreignBookId,
        monitored: true,
        anyEditionOk: false,
        author: {
          authorMetadataId: 0,
          foreignAuthorId: newAuthorId,
          qualityProfileId: options.qualityProfileId,
          metadataProfileId: options.metadataProfileId,
          monitored: true,
          monitorNewItems: 'none',
          tags: options.tags,
          addOptions: {
            searchForMissingBooks: false,
            booksToMonitor: [book.foreignBookId],
          },
          rootFolderPath: options.rootFolderPath,
        },
        editions: [
          {
            bookId: 0,
            foreignEditionId: book.foreignEditionId,
            monitored: true,
            manualAdd: false,
            grabbed: false,
          },
        ],
        grabbed: false,
        addOptions: {
          searchForNewBook: options.searchNow,
        },
      });

      if (data.id) {
        logger.info('Readarr accepted request', { label: 'Readarr' });
        logger.debug('Readarr add details', {
          label: 'Readarr',
          book: data,
        });

        if (options.searchNow) {
          this.searchBook(data.id);
        }
      } else {
        logger.error('Failed to add book to Readarr', {
          label: 'Readarr',
          options,
        });
        throw new Error('Failed to add book to Readarr');
      }
      return data;
    } catch (e) {
      logger.error(
        'Failed to add book to Readarr. This might happen if the book already exists, in which case you can safely ignore this error.',
        {
          label: 'Readarr',
          errorMessage: e.message,
          options,
          response: e?.response?.data,
        }
      );
      throw new Error('Failed to add book to Readarr', { cause: e });
    }
  };

  public async searchBook(bookId: number): Promise<void> {
    logger.info('Executing book search command', {
      label: 'Readarr API',
      bookId: bookId,
    });

    try {
      await this.runCommand('BookSearch', { bookIds: [bookId] });
    } catch (e) {
      logger.error(
        'Something went wrong while executing Readarr book search.',
        {
          label: 'Readarr API',
          errorMessage: e.message,
          bookId: bookId,
        }
      );
    }
  }

  public removeBook = async (hcId: number): Promise<void> => {
    if (this.chaptarrFormat) {
      throw new Error(
        'Chaptarr destructive removal requires a separate native-identity contract.'
      );
    }
    const { id, title } = await this.getBookByHcId(hcId);

    if (!id) {
      logger.info(`[Readarr] Book not in library, nothing to remove`, {
        hcId,
      });
      return;
    }

    try {
      await this.axios.delete(`/book/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion: false,
        },
      });
      logger.info(`[Readarr] Removed book ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Readarr] Book already removed from Readarr`, {
          hcId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tmdbId: hcId,
    externalId,
  }: {
    tmdbId?: number | null;
    externalId?: number | null;
  }) => {
    if (hcId) {
      this.removeCache('/book/lookup', {
        term: `work:${hcId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/book/${externalId}`);
    }
  };
}

export default ReadarrAPI;
