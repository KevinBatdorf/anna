import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type postgres from 'postgres';
import type * as schema from '../db/schema';
import { isVecSearchAvailable, vecSearchGoodreads } from '../lib/vec-search';

type DB = PostgresJsDatabase<typeof schema>;

export function searchRoutes(_db: DB, raw: postgres.Sql) {
	const app = new Hono();

	app.get('/search', (c) => handleBookSearch(c, raw));
	app.get('/search/books', (c) => handleBookSearch(c, raw));

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
				const vecResults = await vecSearchGoodreads(q, raw, limit + offset);
				const sliced = vecResults.slice(offset);
				if (sliced.length > 0) {
					const ids = sliced.map((r) => r.id);
					const distanceMap = new Map(sliced.map((r) => [r.id, r.distance]));

					const rows = await raw`
						SELECT id, source_id, title, author, rating, ratings_count,
						       description, genres, isbn, pages, year
						FROM goodreads WHERE id = ANY(${ids})`;

					const idOrder = new Map(ids.map((id, i) => [id, i]));
					const sorted = rows.toSorted(
						(a, b) =>
							(idOrder.get(a.id as number) ?? 0) -
							(idOrder.get(b.id as number) ?? 0),
					);

					const results = sorted.map((row) => {
						const distance = distanceMap.get(row.id as number) ?? 0;
						const similarity = Math.round((1 - distance) * 1000) / 1000;
						return { ...row, similarity };
					});

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

		try {
			const results = await raw`
				SELECT id, source_id, title, author, rating, ratings_count,
				       description, genres, isbn, pages, year
				FROM goodreads
				WHERE search @@ plainto_tsquery('english', ${q})
				ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC
				LIMIT ${limit}
				OFFSET ${offset}`;

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

async function handleBookSearch(
	c: {
		req: { query(key: string): string | undefined };
		json: (data: unknown, status?: number) => Response;
	},
	raw: postgres.Sql,
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

	try {
		let results: Record<string, unknown>[];

		if (ext) {
			results = await raw`
				SELECT id, source, source_id, title, author, publisher,
				       language, year, extension, filesize, pages, md5, isbn, series
				FROM books
				WHERE extension = ${ext.toLowerCase()}
				  AND search @@ plainto_tsquery('english', ${q})
				LIMIT ${limit}
				OFFSET ${offset}`;
		} else if (dedupe) {
			const overFetch = (limit + offset) * 5;
			const rawRows = await raw`
				SELECT id, source, source_id, title, author, publisher,
				       language, year, extension, filesize, pages, md5, isbn, series
				FROM books
				WHERE search @@ plainto_tsquery('english', ${q})
				ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC,
					CASE extension
						WHEN 'pdf' THEN 0
						WHEN 'epub' THEN 1
						ELSE 2
					END
				LIMIT ${overFetch}`;

			const seen = new Set<string>();
			const deduped: Record<string, unknown>[] = [];
			for (const row of rawRows) {
				const key = `${((row.title as string) || '').toLowerCase()}::${((row.author as string) || '').toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				deduped.push(row);
			}
			results = deduped.slice(offset, offset + limit);
		} else {
			results = await raw`
				SELECT id, source, source_id, title, author, publisher,
				       language, year, extension, filesize, pages, md5, isbn, series
				FROM books
				WHERE search @@ plainto_tsquery('english', ${q})
				ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC,
					CASE extension
						WHEN 'pdf' THEN 0
						WHEN 'epub' THEN 1
						ELSE 2
					END
				LIMIT ${limit}
				OFFSET ${offset}`;
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
