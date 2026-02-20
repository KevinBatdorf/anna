import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { embedSingle, isOllamaEnabled } from './ollama';

export function composeEmbedText(row: {
	title: string;
	author: string;
	description: string;
	genres: string;
}): string {
	return [row.title, row.author, row.description, row.genres]
		.filter(Boolean)
		.join(' | ')
		.slice(0, 2048);
}

/**
 * Open a short-lived readonly connection with sqlite-vec loaded.
 * Caller MUST close the returned database when done.
 * This avoids holding a persistent sqlite-vec lock that blocks the embedder.
 */
export function openVecDb(): Database {
	const dbPath = process.env.DB_PATH || '/data/db/anna.db';
	const vecDb = new Database(dbPath, { readonly: true });
	sqliteVec.load(vecDb);
	vecDb.run('PRAGMA busy_timeout = 5000');
	return vecDb;
}

export function isVecSearchAvailable(): boolean {
	if (!isOllamaEnabled()) return false;
	try {
		const vecDb = openVecDb();
		try {
			const row = vecDb
				.prepare('SELECT COUNT(*) as c FROM goodreads_vec')
				.get() as { c: number } | undefined;
			return (row?.c ?? 0) > 0;
		} finally {
			vecDb.close();
		}
	} catch {
		return false;
	}
}

export async function vecSearchGoodreads(
	query: string,
	limit: number,
): Promise<Array<{ goodreads_id: number; distance: number }>> {
	const queryVec = await embedSingle(query);
	const vecDb = openVecDb();
	try {
		return vecDb
			.prepare(
				`SELECT goodreads_id, distance
       FROM goodreads_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
			)
			.all(queryVec, limit) as Array<{
			goodreads_id: number;
			distance: number;
		}>;
	} finally {
		vecDb.close();
	}
}
