import type postgres from 'postgres';
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
		.slice(0, 8000);
}

/**
 * Goodreads vectors are opt-out on top of OLLAMA_URL. They cost ~90 GB for the
 * full 11M-row catalog, and turning them off here (rather than unsetting
 * OLLAMA_URL) keeps Ollama available for the PDF reader's page embeddings.
 */
export function isGoodreadsVecEnabled(): boolean {
	return process.env.GOODREADS_EMBEDDINGS !== 'false';
}

export function isVecSearchAvailable(): boolean {
	return isOllamaEnabled() && isGoodreadsVecEnabled();
}

export async function vecSearchGoodreads(
	query: string,
	sql: postgres.Sql,
	limit: number,
): Promise<Array<{ id: number; distance: number }>> {
	const queryVec = await embedSingle(query);
	const vecStr = `[${[...queryVec].join(',')}]`;

	const rows = await sql`
		SELECT id, embedding <=> ${vecStr}::vector AS distance
		FROM goodreads
		WHERE embedding IS NOT NULL
		ORDER BY embedding <=> ${vecStr}::vector
		LIMIT ${limit}`;

	return rows.map((r) => ({
		id: r.id as number,
		distance: r.distance as number,
	}));
}
