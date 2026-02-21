import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type postgres from 'postgres';
import type * as schema from '../db/schema';
import {
	composeEmbedText,
	isVecSearchAvailable,
	vecSearchGoodreads,
} from '../lib/vec-search';

type DB = PostgresJsDatabase<typeof schema>;

export function similarRoutes(_db: DB, raw: postgres.Sql) {
	const app = new Hono();

	app.get('/similar', async (c) => {
		const q = c.req.query('q');
		if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
		const limit = Math.min(
			Number.parseInt(c.req.query('limit') || '10', 10),
			50,
		);
		const minRating = Number.parseFloat(c.req.query('min_rating') || '0');
		const minReviews = Number.parseInt(c.req.query('min_reviews') || '0', 10);

		if (!isVecSearchAvailable()) {
			return c.json(
				{
					error:
						'Vector search not available (OLLAMA_URL not set or no embeddings)',
				},
				503,
			);
		}

		// Step 0: If query looks like an ISBN, do a direct lookup
		let sourceBook: Record<string, unknown> | null = null;
		const isbnQuery = q.replace(/[-\s]/g, '');
		if (/^\d{10,13}$/.test(isbnQuery)) {
			try {
				const rows = await raw`
					SELECT id, source_id, title, author, rating, ratings_count,
					       description, genres, isbn, pages, year
					FROM goodreads
					WHERE isbn = ${isbnQuery}
					LIMIT 1`;
				if (rows[0]) sourceBook = rows[0];
			} catch {
				// ISBN lookup failed
			}
		}

		// Step 1: FTS search goodreads for a title match
		// Require the query to appear in the title (case-insensitive) to avoid
		// false positives like "Intervention" matching "Endovascular Interventions"
		if (!sourceBook)
			try {
				const qWords = q.toLowerCase().split(/\s+/).filter(Boolean);
				const rows = await raw`
				SELECT id, source_id, title, author, rating, ratings_count,
				       description, genres, isbn, pages, year,
				       ts_rank(search, plainto_tsquery('english', ${q})) as rank
				FROM goodreads
				WHERE search @@ plainto_tsquery('english', ${q})
				ORDER BY rank DESC
				LIMIT 10`;
				for (const row of rows) {
					const title = ((row.title as string) || '').toLowerCase();
					// Strip subtitles (after : or —) for matching
					const mainTitle = title.split(/[:\u2014]/)[0].trim();
					const titleWords = mainTitle.split(/[\s,-]+/).filter(Boolean);
					// Every query word must appear as a whole word in the main title
					const allMatch = qWords.every((qw) =>
						titleWords.some((tw) => tw === qw),
					);
					if (!allMatch) continue;
					// Query must cover most of the main title words
					const coverage = qWords.length / titleWords.length;
					if (coverage >= 0.6) {
						sourceBook = row;
						break;
					}
				}
			} catch {
				// FTS lookup failed
			}

		// Step 2: Not found in goodreads — check books table for a download
		if (!sourceBook) {
			let download: Record<string, unknown> | null = null;
			try {
				const bookRows = await raw`
					SELECT id, source, source_id, title, author, publisher,
					       language, year, extension, filesize, pages, md5, isbn, series
					FROM books
					WHERE search @@ plainto_tsquery('english', ${q})
					ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC
					LIMIT 1`;
				if (bookRows[0]) download = bookRows[0];
			} catch {
				// FTS lookup failed
			}
			return c.json({
				query: q,
				found: false,
				...(download ? { download } : {}),
			});
		}

		// Step 3: Embed source book text, vector search for neighbors
		const embedText = composeEmbedText({
			title: (sourceBook.title as string) || '',
			author: (sourceBook.author as string) || '',
			description: (sourceBook.description as string) || '',
			genres: (sourceBook.genres as string) || '',
		});

		try {
			const overFetch =
				minRating > 0 || minReviews > 0 ? limit * 3 : limit + 10;
			const vecResults = await vecSearchGoodreads(embedText, raw, overFetch);

			// Exclude the source book
			const filtered = vecResults.filter(
				(r) => r.id !== (sourceBook?.id as number),
			);
			const ids = filtered.map((r) => r.id);
			const distanceMap = new Map(filtered.map((r) => [r.id, r.distance]));

			if (ids.length === 0) {
				return c.json({
					query: q,
					found: true,
					source: sourceBook,
					count: 0,
					results: [],
				});
			}

			// Step 5: Fetch results with conditional filters (single query)
			const grRows: Record<string, unknown>[] = await raw`
				SELECT id, source_id, title, author, rating, ratings_count,
				       description, genres, isbn, pages, year
				FROM goodreads
				WHERE id = ANY(${ids})
					${minRating > 0 ? raw`AND rating >= ${minRating}` : raw``}
					${minReviews > 0 ? raw`AND ratings_count >= ${minReviews}` : raw``}`;

			// Preserve vec search ordering
			const idOrder = new Map(ids.map((id, i) => [id, i]));
			const sorted = grRows.toSorted(
				(a, b) =>
					(idOrder.get(a.id as number) ?? 0) -
					(idOrder.get(b.id as number) ?? 0),
			);
			const sliced = sorted.slice(0, limit);

			// Step 6: Batch ISBN availability check
			const isbns = sliced.filter((r) => r.isbn).map((r) => r.isbn as string);
			const availableIsbns =
				isbns.length > 0
					? new Set(
							(
								await raw`SELECT DISTINCT isbn FROM books WHERE isbn = ANY(${isbns})`
							).map((r) => r.isbn as string),
						)
					: new Set<string>();

			const results = sliced.map((gr) => {
				const distance = distanceMap.get(gr.id as number) ?? 0;
				const similarity = Math.round((1 - distance) * 1000) / 1000;
				const available = gr.isbn
					? availableIsbns.has(gr.isbn as string)
					: false;
				return { ...gr, similarity, available };
			});

			return c.json({
				query: q,
				found: true,
				source: sourceBook,
				count: results.length,
				results,
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Similar search failed', detail: msg }, 500);
		}
	});

	return app;
}
