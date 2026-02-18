import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { sanitizeFtsQuery } from '../lib/sanitize-fts';

type DB = BunSQLiteDatabase<typeof schema>;

export function searchRoutes(db: DB) {
	const app = new Hono();

	app.get('/search', (c) => handleBookSearch(c, db));
	app.get('/search/books', (c) => handleBookSearch(c, db));

	app.get('/search/goodreads', (c) => {
		const q = c.req.query('q');
		if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
		const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
		const offset = parseInt(c.req.query('offset') || '0', 10);
		const ftsQuery = sanitizeFtsQuery(q);
		if (!ftsQuery) return c.json({ error: 'Invalid query' }, 400);

		try {
			const results = db.all<Record<string, unknown>>(sql`
        SELECT g.id, g.source_id, g.title, g.author, g.rating, g.ratings_count,
               g.description, g.genres, g.isbn, g.pages, g.year
        FROM goodreads_fts f
        JOIN goodreads g ON g.id = f.rowid
        WHERE goodreads_fts MATCH ${ftsQuery}
        ORDER BY rank
        LIMIT ${limit}
        OFFSET ${offset}
      `);
			return c.json({ query: q, count: results.length, offset, results });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Search failed', detail: msg }, 500);
		}
	});

	return app;
}

function handleBookSearch(
	c: {
		req: { query(key: string): string | undefined };
		json: (data: unknown, status?: number) => Response;
	},
	db: DB,
) {
	const q = c.req.query('q');
	if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
	const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
	const offset = parseInt(c.req.query('offset') || '0', 10);
	const ftsQuery = sanitizeFtsQuery(q);
	if (!ftsQuery) return c.json({ error: 'Invalid query' }, 400);

	try {
		const results = db.all<Record<string, unknown>>(sql`
      SELECT b.id, b.source, b.source_id, b.title, b.author, b.publisher,
             b.language, b.year, b.extension, b.filesize, b.pages, b.md5, b.isbn, b.series
      FROM books_fts f
      JOIN books b ON b.id = f.rowid
      WHERE books_fts MATCH ${ftsQuery}
      ORDER BY rank
      LIMIT ${limit}
      OFFSET ${offset}
    `);
		return c.json({ query: q, count: results.length, offset, results });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		return c.json({ error: 'Search failed', detail: msg }, 500);
	}
}
