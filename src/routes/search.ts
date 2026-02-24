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
		const author = c.req.query('author');
		const year = c.req.query('year');
		const genre = c.req.query('genre');
		const searchType = c.req.query('search_type'); // 'fts' | 'vector'
		const hasFilters = author || year || genre;

		if (!q && !hasFilters)
			return c.json(
				{
					error:
						'Provide ?q= and/or filter params (author, year, genre). Optional: search_type=fts|vector',
				},
				400,
			);

		const limit = Math.min(
			Number.parseInt(c.req.query('limit') || '20', 10),
			100,
		);
		const offset = Number.parseInt(c.req.query('offset') || '0', 10);

		// Vector search: use when explicitly requested or auto (no filters, no override)
		const tryVector = searchType === 'vector' || (!searchType && !hasFilters);
		if (q && tryVector && isVecSearchAvailable()) {
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
				if (searchType === 'vector')
					return c.json({ error: 'Vector search failed' }, 500);
			}
		}

		if (searchType === 'vector')
			return c.json(
				{ error: 'Vector search unavailable (no OLLAMA_URL or no results)' },
				400,
			);

		// Build WHERE fragments for FTS + filters
		const conditions = [];
		if (q) conditions.push(raw`search @@ plainto_tsquery('english', ${q})`);
		if (author) conditions.push(raw`author ILIKE ${`%${author}%`}`);
		if (year) conditions.push(raw`year = ${year}`);
		if (genre) conditions.push(raw`genres ILIKE ${`%${genre}%`}`);

		const where = conditions.reduce((acc, cond, i) =>
			i === 0 ? cond : raw`${acc} AND ${cond}`,
		);

		const orderBy = q
			? raw`ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC`
			: raw`ORDER BY rating DESC NULLS LAST`;

		try {
			const results = await raw`
				SELECT id, source_id, title, author, rating, ratings_count,
				       description, genres, isbn, pages, year
				FROM goodreads
				WHERE ${where}
				${orderBy}
				LIMIT ${limit}
				OFFSET ${offset}`;

			return c.json({
				...(q ? { query: q } : {}),
				...(author ? { author } : {}),
				...(year ? { year } : {}),
				...(genre ? { genre } : {}),
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
	const author = c.req.query('author');
	const publisher = c.req.query('publisher');
	const language = c.req.query('language');
	const year = c.req.query('year');
	const hasFilters = author || publisher || language || year;

	if (!q && !hasFilters)
		return c.json(
			{
				error:
					'Provide ?q= and/or filter params (author, publisher, language, year)',
			},
			400,
		);

	const limit = Math.min(
		Number.parseInt(c.req.query('limit') || '20', 10),
		100,
	);
	const offset = Number.parseInt(c.req.query('offset') || '0', 10);
	const ext = c.req.query('ext');
	const dedupe = c.req.query('dedupe') !== 'false';

	// Build WHERE fragments
	const conditions = [];
	if (q) conditions.push(raw`search @@ plainto_tsquery('english', ${q})`);
	if (author) conditions.push(raw`author ILIKE ${`%${author}%`}`);
	if (publisher) conditions.push(raw`publisher ILIKE ${`%${publisher}%`}`);
	if (language) conditions.push(raw`language = ${language.toLowerCase()}`);
	if (year) conditions.push(raw`year = ${year}`);
	if (ext) conditions.push(raw`extension = ${ext.toLowerCase()}`);

	const where = conditions.reduce((acc, cond, i) =>
		i === 0 ? cond : raw`${acc} AND ${cond}`,
	);

	const orderBy = q
		? raw`ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC,
			CASE extension WHEN 'pdf' THEN 0 WHEN 'epub' THEN 1 ELSE 2 END`
		: raw`ORDER BY id DESC`;

	try {
		let results: Record<string, unknown>[];

		if (dedupe) {
			const overFetch = (limit + offset) * 5;
			const rawRows = await raw`
				SELECT id, source, source_id, title, author, publisher,
				       language, year, extension, filesize, pages, md5, isbn, series
				FROM books
				WHERE ${where}
				${orderBy}
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
				WHERE ${where}
				${orderBy}
				LIMIT ${limit}
				OFFSET ${offset}`;
		}

		return c.json({
			...(q ? { query: q } : {}),
			...(author ? { author } : {}),
			...(publisher ? { publisher } : {}),
			...(language ? { language } : {}),
			...(year ? { year } : {}),
			...(ext ? { ext } : {}),
			count: results.length,
			offset,
			results,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		return c.json({ error: 'Search failed', detail: msg }, 500);
	}
}
