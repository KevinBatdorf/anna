import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import type * as schema from '../db/schema';
import { importMeta } from '../db/schema';

type DB = BunSQLiteDatabase<typeof schema>;

export function statsRoutes(db: DB) {
	const app = new Hono();

	app.get('/stats', (c) => {
		const meta = db.select().from(importMeta).all();
		const metaObj = Object.fromEntries(
			meta
				.filter((m) => m.key !== 'embeddings_count')
				.map((m) => [m.key, m.value]),
		);

		const goodreadsCount = Number(metaObj.goodreads_count ?? 0);
		const lastId = Number(metaObj.embeddings_last_id ?? 0);
		const progress =
			goodreadsCount > 0 && lastId > 0
				? Math.round((lastId / goodreadsCount) * 1000) / 10
				: 0;

		return c.json({
			books: Number(metaObj.zlib3_count ?? 0),
			goodreads: goodreadsCount,
			embeddings: lastId,
			embeddings_model: metaObj.embeddings_model ?? null,
			embeddings_progress: progress > 0 ? `${progress}%` : null,
			import: metaObj,
		});
	});

	return app;
}
