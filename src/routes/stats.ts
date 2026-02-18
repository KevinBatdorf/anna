import { count } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { books, goodreads, importMeta } from '../db/schema';

type DB = BunSQLiteDatabase<typeof schema>;

export function statsRoutes(db: DB) {
	const app = new Hono();

	app.get('/stats', (c) => {
		const meta = db.select().from(importMeta).all();
		const metaObj = Object.fromEntries(meta.map((m) => [m.key, m.value]));
		const bookCount =
			db.select({ count: count() }).from(books).get()?.count ?? 0;
		const grCount =
			db.select({ count: count() }).from(goodreads).get()?.count ?? 0;
		return c.json({ books: bookCount, goodreads: grCount, import: metaObj });
	});

	return app;
}
