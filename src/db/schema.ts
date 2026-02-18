import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const books = sqliteTable('books', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	source: text('source').notNull(),
	source_id: text('source_id'),
	title: text('title'),
	author: text('author'),
	publisher: text('publisher'),
	language: text('language'),
	year: text('year'),
	extension: text('extension'),
	filesize: integer('filesize'),
	pages: text('pages'),
	description: text('description'),
	md5: text('md5'),
	isbn: text('isbn'),
	series: text('series'),
	edition: text('edition'),
});

export const goodreads = sqliteTable('goodreads', {
	id: integer('id').primaryKey({ autoIncrement: true }),
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
});

export const importMeta = sqliteTable('import_meta', {
	key: text('key').primaryKey(),
	value: text('value'),
});

export type Book = typeof books.$inferSelect;
export type Goodreads = typeof goodreads.$inferSelect;
export type ImportMeta = typeof importMeta.$inferSelect;
