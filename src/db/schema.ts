import { type SQL, sql } from 'drizzle-orm';
import {
	bigint,
	customType,
	index,
	integer,
	pgTable,
	real,
	serial,
	text,
	timestamp,
	uniqueIndex,
	vector,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
	dataType() {
		return 'tsvector';
	},
});

export const books = pgTable(
	'books',
	{
		id: serial('id').primaryKey(),
		source: text('source').notNull(),
		source_id: text('source_id'),
		title: text('title'),
		author: text('author'),
		publisher: text('publisher'),
		language: text('language'),
		year: text('year'),
		extension: text('extension'),
		filesize: bigint('filesize', { mode: 'number' }),
		pages: text('pages'),
		description: text('description'),
		md5: text('md5'),
		isbn: text('isbn'),
		series: text('series'),
		edition: text('edition'),
		created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
		search: tsvector('search').generatedAlwaysAs(
			(): SQL =>
				sql`setweight(to_tsvector('english', coalesce(${books.title}, '')), 'A') ||
			setweight(to_tsvector('english', coalesce(${books.author}, '')), 'B') ||
			setweight(to_tsvector('english', coalesce(${books.publisher}, '')), 'C') ||
			setweight(to_tsvector('english', coalesce(${books.description}, '')), 'D') ||
			to_tsvector('english', coalesce(${books.isbn}, ''))`,
		),
	},
	(t) => [
		uniqueIndex('idx_books_source_id').on(t.source_id),
		index('idx_books_md5').on(t.md5),
		index('idx_books_isbn').on(t.isbn),
		index('idx_books_language').on(t.language),
		index('idx_books_extension').on(t.extension),
		index('idx_books_search').using('gin', t.search),
	],
);

export const goodreads = pgTable(
	'goodreads',
	{
		id: serial('id').primaryKey(),
		source_id: text('source_id'),
		title: text('title'),
		author: text('author'),
		rating: real('rating'),
		ratings_count: integer('ratings_count'),
		description: text('description'),
		genres: text('genres'),
		isbn: text('isbn'),
		pages: text('pages'),
		year: text('year'),
		embedding: vector('embedding', { dimensions: 768 }),
		created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
		search: tsvector('search').generatedAlwaysAs(
			(): SQL =>
				sql`setweight(to_tsvector('english', coalesce(${goodreads.title}, '')), 'A') ||
			setweight(to_tsvector('english', coalesce(${goodreads.author}, '')), 'B') ||
			setweight(to_tsvector('english', coalesce(${goodreads.description}, '')), 'C') ||
			setweight(to_tsvector('english', coalesce(${goodreads.genres}, '')), 'D') ||
			to_tsvector('english', coalesce(${goodreads.isbn}, ''))`,
		),
	},
	(t) => [
		uniqueIndex('idx_goodreads_source_id').on(t.source_id),
		index('idx_goodreads_isbn').on(t.isbn),
		index('idx_goodreads_search').using('gin', t.search),
		// IVFFlat index created by importer after embeddings complete (see embed.ts)
		// Not declared here because it needs dynamic `lists` param based on row count
	],
);

export const importMeta = pgTable('import_meta', {
	key: text('key').primaryKey(),
	value: text('value'),
});

export type Book = typeof books.$inferSelect;
export type Goodreads = typeof goodreads.$inferSelect;
export type ImportMeta = typeof importMeta.$inferSelect;
