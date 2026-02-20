import type { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { sanitizeFtsQuery } from '../lib/sanitize-fts';
import { isVecSearchAvailable, vecSearchGoodreads } from '../lib/vec-search';

type DB = BunSQLiteDatabase<typeof schema>;

export function searchRoutes(db: DB, rawDb: Database) {
	const app = new Hono();

	app.get('/search', (c) => handleBookSearch(c, rawDb));
	app.get('/search/books', (c) => handleBookSearch(c, rawDb));

	app.get('/search/goodreads', async (c) => {
		const q = c.req.query('q');
		if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
		const limit = Math.min(
			Number.parseInt(c.req.query('limit') || '20', 10),
			100,
		);
		const offset = Number.parseInt(c.req.query('offset') || '0', 10);

		if (isVecSearchAvailable()) {
			try {
				const vecResults = await vecSearchGoodreads(q, limit + offset);
				const sliced = vecResults.slice(offset);
				if (sliced.length > 0) {
					const ids = sliced.map((r) => r.goodreads_id);
					const placeholders = ids.map(() => '?').join(',');
					const results = rawDb
						.prepare(
							`SELECT id, source_id, title, author, rating, ratings_count,
                    description, genres, isbn, pages, year
             FROM goodreads WHERE id IN (${placeholders})`,
						)
						.all(...ids) as Record<string, unknown>[];

					const idOrder = new Map(ids.map((id, i) => [id, i]));
					results.sort(
						(a: Record<string, unknown>, b: Record<string, unknown>) =>
							(idOrder.get(a.id as number) ?? 0) -
							(idOrder.get(b.id as number) ?? 0),
					);

					return c.json({
						query: q,
						count: results.length,
						offset,
						search_type: 'vector',
						results,
					});
				}
			} catch {
				// Fall through to FTS
			}
		}

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
			return c.json({
				query: q,
				count: results.length,
				offset,
				search_type: 'fts',
				results,
			});
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
	rawDb: Database,
) {
	const q = c.req.query('q');
	if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
	const limit = Math.min(
		Number.parseInt(c.req.query('limit') || '20', 10),
		100,
	);
	const offset = Number.parseInt(c.req.query('offset') || '0', 10);
	const ext = c.req.query('ext');
	const dedupe = c.req.query('dedupe') !== 'false';
	const ftsQuery = sanitizeFtsQuery(q);
	if (!ftsQuery) return c.json({ error: 'Invalid query' }, 400);

	try {
		let results: Record<string, unknown>[];

		if (ext) {
			results = rawDb
				.prepare(
					`SELECT b.id, b.source, b.source_id, b.title, b.author, b.publisher,
                    b.language, b.year, b.extension, b.filesize, b.pages, b.md5, b.isbn, b.series
             FROM books_fts f
             JOIN books b ON b.id = f.rowid
             WHERE books_fts MATCH ?
               AND b.extension = ?
             ORDER BY rank
             LIMIT ?
             OFFSET ?`,
				)
				.all(ftsQuery, ext.toLowerCase(), limit, offset) as Record<
				string,
				unknown
			>[];
		} else if (dedupe) {
			// Fetch extra rows, then deduplicate by title+author keeping best format
			const overFetch = (limit + offset) * 5;
			const raw = rawDb
				.prepare(
					`SELECT b.id, b.source, b.source_id, b.title, b.author, b.publisher,
                    b.language, b.year, b.extension, b.filesize, b.pages, b.md5, b.isbn, b.series
             FROM books_fts f
             JOIN books b ON b.id = f.rowid
             WHERE books_fts MATCH ?
             ORDER BY rank,
               CASE b.extension
                 WHEN 'pdf' THEN 0
                 WHEN 'epub' THEN 1
                 ELSE 2
               END
             LIMIT ?`,
				)
				.all(ftsQuery, overFetch) as Record<string, unknown>[];

			const seen = new Set<string>();
			const deduped: Record<string, unknown>[] = [];
			for (const row of raw) {
				const key = `${((row.title as string) || '').toLowerCase()}::${((row.author as string) || '').toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				deduped.push(row);
			}
			results = deduped.slice(offset, offset + limit);
		} else {
			results = rawDb
				.prepare(
					`SELECT b.id, b.source, b.source_id, b.title, b.author, b.publisher,
                    b.language, b.year, b.extension, b.filesize, b.pages, b.md5, b.isbn, b.series
             FROM books_fts f
             JOIN books b ON b.id = f.rowid
             WHERE books_fts MATCH ?
             ORDER BY rank,
               CASE b.extension
                 WHEN 'pdf' THEN 0
                 WHEN 'epub' THEN 1
                 ELSE 2
               END
             LIMIT ?
             OFFSET ?`,
				)
				.all(ftsQuery, limit, offset) as Record<string, unknown>[];
		}

		return c.json({
			query: q,
			count: results.length,
			offset,
			...(ext ? { ext } : {}),
			results,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		return c.json({ error: 'Search failed', detail: msg }, 500);
	}
}
