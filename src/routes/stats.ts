import { Hono } from 'hono';
import type postgres from 'postgres';

export function statsRoutes(raw: postgres.Sql) {
	const app = new Hono();

	app.get('/stats', async (c) => {
		try {
			// Check if import_meta table exists (may not on fresh DB)
			const tableCheck = await raw`
				SELECT EXISTS (
					SELECT 1 FROM information_schema.tables
					WHERE table_name = 'import_meta'
				) as exists`;

			if (!tableCheck[0]?.exists) {
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

			const meta = await raw`SELECT key, value FROM import_meta`;
			const metaObj = Object.fromEntries(
				meta
					.filter((m) => m.key !== 'embeddings_count')
					.map((m) => [m.key, m.value]),
			);

			// MAX(id) hits the PK index — instant even during active imports
			const [{ c: bookCount }] =
				await raw`SELECT COALESCE(MAX(id), 0) as c FROM books`;
			const [{ c: goodreadsCount }] =
				await raw`SELECT COALESCE(MAX(id), 0) as c FROM goodreads`;

			const grCount = Number(goodreadsCount);
			const embCount = Number(metaObj.embeddings_last_id ?? 0);
			const progress =
				grCount > 0 && embCount > 0
					? Math.round((embCount / grCount) * 1000) / 10
					: 0;

			return c.json({
				books: Number(bookCount),
				goodreads: grCount,
				embeddings: embCount,
				embeddings_model: metaObj.embeddings_model ?? null,
				embeddings_progress: progress > 0 ? `${progress}%` : null,
				import: metaObj,
			});
		} catch {
			return c.json({
				books: 0,
				goodreads: 0,
				embeddings: 0,
				embeddings_model: null,
				embeddings_progress: null,
				import: {},
				status: 'starting',
			});
		}
	});

	return app;
}
