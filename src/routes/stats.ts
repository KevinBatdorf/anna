import { Hono } from 'hono';
import type postgres from 'postgres';

export function statsRoutes(raw: postgres.Sql) {
	const app = new Hono();

	app.get('/stats', async (c) => {
		const [[{ c: embedCount }], metaRows] = await Promise.all([
			raw`SELECT COUNT(*)::int as c FROM goodreads WHERE embedding IS NOT NULL`,
			raw`SELECT key, value FROM import_meta ORDER BY key`,
		]);

		const meta: Record<string, string> = {};
		for (const row of metaRows) meta[row.key] = row.value;

		const importing = !!meta.import_started && !meta.import_finished;
		const booksDone = meta.books_done === 'true';
		const grDone = meta.goodreads_done === 'true';

		const grCount = Number(meta.goodreads_count) || 0;
		const embeds = Number(embedCount);

		return c.json({
			books: {
				count: Number(meta.books_count) || 0,
				status: booksDone ? 'done' : importing ? 'importing' : 'pending',
			},
			goodreads: {
				count: grCount,
				status: grDone
					? 'done'
					: booksDone && importing
						? 'importing'
						: 'pending',
			},
			embeddings: {
				count: embeds,
				total: grCount,
				percent: grCount > 0 ? Math.round((embeds / grCount) * 1000) / 10 : 0,
				status:
					grDone && importing
						? 'importing'
						: grDone && !importing
							? 'done'
							: 'pending',
			},
			import: {
				started_at: meta.import_started || null,
				finished_at: meta.import_finished || null,
				error: meta.import_error || null,
			},
		});
	});

	return app;
}
