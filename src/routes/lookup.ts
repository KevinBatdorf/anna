import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { books, goodreads } from '../db/schema';

type DB = PostgresJsDatabase<typeof schema>;

export function lookupRoutes(db: DB) {
	const app = new Hono();

	app.get('/lookup/md5', async (c) => {
		const md5 = c.req.query('md5');
		if (!md5) return c.json({ error: 'Missing ?md5= parameter' }, 400);
		const results = await db
			.select()
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
			.select()
			.from(books)
			.where(eq(books.isbn, isbn))
			.limit(1);
		const grResults = await db
			.select()
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
