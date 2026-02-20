import type { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { sanitizeFtsQuery } from '../lib/sanitize-fts';
import {
	composeEmbedText,
	isVecSearchAvailable,
	vecSearchGoodreads,
} from '../lib/vec-search';

type DB = BunSQLiteDatabase<typeof schema>;

export function similarRoutes(db: DB, rawDb: Database) {
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

		// Try to find a specific book in goodreads via FTS
		const ftsQuery = sanitizeFtsQuery(q);
		if (!ftsQuery) return c.json({ error: 'Invalid query' }, 400);

		let sourceBook: Record<string, unknown> | null = null;
		try {
			const rows = db.all<Record<string, unknown>>(sql`
				SELECT g.id, g.source_id, g.title, g.author, g.rating, g.ratings_count,
				       g.description, g.genres, g.isbn, g.pages, g.year
				FROM goodreads_fts f
				JOIN goodreads g ON g.id = f.rowid
				WHERE goodreads_fts MATCH ${ftsQuery}
				ORDER BY rank
				LIMIT 1
			`);
			sourceBook = rows[0] ?? null;
		} catch {
			// FTS lookup failed — fall through to raw query
		}

		// Use the source book's full text if found, otherwise the raw query
		const embedText = sourceBook
			? composeEmbedText({
					title: (sourceBook.title as string) || '',
					author: (sourceBook.author as string) || '',
					description: (sourceBook.description as string) || '',
					genres: (sourceBook.genres as string) || '',
				})
			: q;

		try {
			// Over-fetch to account for filtering
			const overFetch =
				minRating > 0 || minReviews > 0 ? limit * 3 : limit + 10;
			const vecResults = await vecSearchGoodreads(embedText, overFetch);

			// Exclude the source book if we matched one
			const sourceId = sourceBook ? (sourceBook.id as number) : -1;
			const filtered = vecResults.filter((r) => r.goodreads_id !== sourceId);
			const ids = filtered.map((r) => r.goodreads_id);
			const distanceMap = new Map(
				filtered.map((r) => [r.goodreads_id, r.distance]),
			);

			if (ids.length === 0) {
				return c.json({
					query: q,
					...(sourceBook ? { source: sourceBook } : {}),
					count: 0,
					results: [],
				});
			}

			const placeholders = ids.map(() => '?').join(',');

			// Build WHERE clause with optional rating filters
			const conditions = [`id IN (${placeholders})`];
			const params: unknown[] = [...ids];
			if (minRating > 0) {
				conditions.push('rating >= ?');
				params.push(minRating);
			}
			if (minReviews > 0) {
				conditions.push('ratings_count >= ?');
				params.push(minReviews);
			}

			const grRows = rawDb
				.prepare(
					`SELECT id, source_id, title, author, rating, ratings_count,
					        description, genres, isbn, pages, year
					 FROM goodreads WHERE ${conditions.join(' AND ')}`,
				)
				.all(...params) as Record<string, unknown>[];

			// Preserve vec search ordering
			const idOrder = new Map(ids.map((id, i) => [id, i]));
			grRows.sort(
				(a, b) =>
					(idOrder.get(a.id as number) ?? 0) -
					(idOrder.get(b.id as number) ?? 0),
			);

			// Join books by ISBN for availability, attach similarity score
			const results = grRows.slice(0, limit).map((gr) => {
				let available = null;
				if (gr.isbn) {
					const found = rawDb
						.prepare('SELECT * FROM books WHERE isbn = ? LIMIT 1')
						.get(gr.isbn as string) as Record<string, unknown> | undefined;
					available = found ?? null;
				}
				const distance = distanceMap.get(gr.id as number) ?? 0;
				const similarity = Math.round((1 - distance) * 1000) / 1000;
				return { ...gr, similarity, available };
			});

			return c.json({
				query: q,
				...(sourceBook ? { source: sourceBook } : {}),
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
