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

export function isVecSearchAvailable(): boolean {
	return isOllamaEnabled();
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
