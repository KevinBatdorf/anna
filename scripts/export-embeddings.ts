/**
 * Export embeddings from Postgres to a JSON file on disk.
 * This creates a cache file so embeddings survive database rebuilds.
 *
 * Usage: bun run scripts/export-embeddings.ts
 * Output: data/embeddings-cache.json
 */

import postgres from 'postgres';

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://anna:anna@localhost:5432/anna';
const OUTPUT_PATH = `${import.meta.dirname}/../data/embeddings-cache.json`;

async function main() {
	const sql = postgres(DATABASE_URL, { max: 5 });

	try {
		const rows = await sql`
			SELECT id, embedding::text
			FROM goodreads
			WHERE embedding IS NOT NULL
		`;

		console.log(`Found ${rows.length} embeddings`);

		if (rows.length === 0) {
			console.log('No embeddings to export');
			return;
		}

		const cache: Record<string, number[]> = {};
		for (const row of rows) {
			// Postgres returns vector as "[0.1,0.2,...]" string
			const vec = row.embedding
				.replace(/^\[/, '')
				.replace(/\]$/, '')
				.split(',')
				.map(Number);
			cache[row.id] = vec;
		}

		await Bun.write(OUTPUT_PATH, JSON.stringify(cache));

		const stat = await Bun.file(OUTPUT_PATH).size;
		console.log(
			`Exported ${rows.length} embeddings to ${OUTPUT_PATH} (${(stat / 1024 / 1024).toFixed(1)} MB)`,
		);
	} finally {
		await sql.end();
	}
}

main().catch((err) => {
	console.error('Export failed:', err.message);
	process.exit(1);
});
