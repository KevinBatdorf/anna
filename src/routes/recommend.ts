import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { sanitizeFtsQuery } from '../lib/sanitize-fts';

type DB = BunSQLiteDatabase<typeof schema>;

export function recommendRoutes(db: DB) {
	const app = new Hono();

	app.get('/recommend', (c) => {
		const q = c.req.query('q');
		if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
		const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 50);
		const ftsQuery = sanitizeFtsQuery(q);
		if (!ftsQuery) return c.json({ error: 'Invalid query' }, 400);

		try {
			const grResults = db.all<Record<string, unknown>>(sql`
        SELECT g.id, g.source_id, g.title, g.author, g.rating, g.ratings_count,
               g.description, g.genres, g.isbn, g.pages, g.year
        FROM goodreads_fts f
        JOIN goodreads g ON g.id = f.rowid
        WHERE goodreads_fts MATCH ${ftsQuery}
        AND g.rating >= 3.5
        AND g.ratings_count >= 100
        ORDER BY g.rating DESC
        LIMIT ${limit}
      `);

			const results = grResults.map((gr: Record<string, unknown>) => {
				let available = null;
				if (gr.isbn) {
					const found = db.all<Record<string, unknown>>(sql`
            SELECT * FROM books WHERE isbn = ${gr.isbn as string} LIMIT 1
          `);
					available = found[0] ?? null;
				}
				return { ...gr, available };
			});

			return c.json({ query: q, count: results.length, results });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Recommend failed', detail: msg }, 500);
		}
	});

	return app;
}
