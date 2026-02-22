import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { books, goodreads } from '../db/schema';

type DB = PostgresJsDatabase<typeof schema>;

const bookColumns = {
	id: books.id,
	source: books.source,
	source_id: books.source_id,
	title: books.title,
	author: books.author,
	publisher: books.publisher,
	language: books.language,
	year: books.year,
	extension: books.extension,
	filesize: books.filesize,
	pages: books.pages,
	description: books.description,
	md5: books.md5,
	isbn: books.isbn,
	series: books.series,
	edition: books.edition,
} as const;

const goodreadsColumns = {
	id: goodreads.id,
	source_id: goodreads.source_id,
	title: goodreads.title,
	author: goodreads.author,
	rating: goodreads.rating,
	ratings_count: goodreads.ratings_count,
	description: goodreads.description,
	genres: goodreads.genres,
	isbn: goodreads.isbn,
	pages: goodreads.pages,
	year: goodreads.year,
} as const;

export function lookupRoutes(db: DB) {
	const app = new Hono();

	app.get('/lookup/md5', async (c) => {
		const md5 = c.req.query('md5');
		if (!md5) return c.json({ error: 'Missing ?md5= parameter' }, 400);
		const results = await db
			.select(bookColumns)
			.from(books)
			.where(eq(books.md5, md5))
			.limit(1);
		return results[0]
			? c.json(results[0])
			: c.json({ error: 'Not found' }, 404);
	});

	app.get('/lookup/isbn', async (c) => {
		const isbn = c.req.query('isbn');
		if (!isbn) return c.json({ error: 'Missing ?isbn= parameter' }, 400);
		const bookResults = await db
			.select(bookColumns)
			.from(books)
			.where(eq(books.isbn, isbn))
			.limit(1);
		const grResults = await db
			.select(goodreadsColumns)
			.from(goodreads)
			.where(eq(goodreads.isbn, isbn))
			.limit(1);
		return c.json({
			book: bookResults[0] ?? null,
			goodreads: grResults[0] ?? null,
		});
	});

	return app;
}
