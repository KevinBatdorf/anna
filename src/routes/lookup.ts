import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { books, goodreads } from '../db/schema';

type DB = BunSQLiteDatabase<typeof schema>;

export function lookupRoutes(db: DB) {
	const app = new Hono();

	app.get('/lookup/md5', (c) => {
		const md5 = c.req.query('md5');
		if (!md5) return c.json({ error: 'Missing ?md5= parameter' }, 400);
		const result = db.select().from(books).where(eq(books.md5, md5)).get();
		return result ? c.json(result) : c.json({ error: 'Not found' }, 404);
	});

	app.get('/lookup/isbn', (c) => {
		const isbn = c.req.query('isbn');
		if (!isbn) return c.json({ error: 'Missing ?isbn= parameter' }, 400);
		const book =
			db.select().from(books).where(eq(books.isbn, isbn)).get() ?? null;
		const gr =
			db.select().from(goodreads).where(eq(goodreads.isbn, isbn)).get() ?? null;
		return c.json({ book, goodreads: gr });
	});

	return app;
}
