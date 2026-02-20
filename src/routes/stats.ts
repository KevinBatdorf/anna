import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';

/** Fast approximate row count using max(rowid). Doesn't block on write locks. */
function approxCount(raw: Database, table: string): number {
	try {
		const row = raw.prepare(`SELECT MAX(rowid) as c FROM ${table}`).get() as {
			c: number;
		} | null;
		return row?.c ?? 0;
	} catch {
		return 0;
	}
}

export function statsRoutes(raw: Database) {
	const app = new Hono();

	app.get('/stats', (c) => {
		try {
			// Check if import_meta table exists (may not on fresh DB)
			const tableExists = raw
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='import_meta'",
				)
				.get();

			if (!tableExists) {
				return c.json({
					books: 0,
					goodreads: 0,
					embeddings: 0,
					embeddings_model: null,
					embeddings_progress: null,
					import: {},
					status: 'importing',
				});
			}

			const meta = raw.prepare('SELECT key, value FROM import_meta').all() as {
				key: string;
				value: string;
			}[];
			const metaObj = Object.fromEntries(
				meta
					.filter((m) => m.key !== 'embeddings_count')
					.map((m) => [m.key, m.value]),
			);

			// Use max(rowid) for fast approximate counts that don't block imports
			const bookCount = approxCount(raw, 'books');
			const goodreadsCount = approxCount(raw, 'goodreads');

			const lastId = Number(metaObj.embeddings_last_id ?? 0);
			const progress =
				goodreadsCount > 0 && lastId > 0
					? Math.round((lastId / goodreadsCount) * 1000) / 10
					: 0;

			return c.json({
				books: bookCount,
				goodreads: goodreadsCount,
				embeddings: lastId,
				embeddings_model: metaObj.embeddings_model ?? null,
				embeddings_progress: progress > 0 ? `${progress}%` : null,
				import: metaObj,
			});
		} catch {
			// DB may be locked during heavy imports — return safe defaults
			return c.json({
				books: 0,
				goodreads: 0,
				embeddings: 0,
				embeddings_model: null,
				embeddings_progress: null,
				import: {},
				status: 'importing',
			});
		}
	});

	return app;
}
