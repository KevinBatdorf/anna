import type postgres from 'postgres';
import { embed, getEmbedModel, isOllamaEnabled } from '../../src/lib/ollama';
import { composeEmbedText } from '../../src/lib/vec-search';

const BATCH_SIZE = 10;
const dataDir = `${import.meta.dirname}/../../data`;
const CACHE_PATH = `${dataDir}/embeddings-cache.json`;

const loadEmbeddingCache = async (): Promise<Record<string, number[]>> => {
	const file = Bun.file(CACHE_PATH);
	if (!(await file.exists())) return {};
	return file.json();
};

const saveEmbeddingCache = async (sql: postgres.Sql) => {
	const rows = await sql`
		SELECT id, embedding::text
		FROM goodreads
		WHERE embedding IS NOT NULL
	`;
	if (rows.length === 0) return;

	const cache: Record<string, number[]> = {};
	for (const row of rows) {
		const vec = row.embedding
			.replace(/^\[/, '')
			.replace(/\]$/, '')
			.split(',')
			.map(Number);
		cache[row.id] = vec;
	}
	await Bun.write(CACHE_PATH, JSON.stringify(cache));
};

const embedMissing = async (sql: postgres.Sql) => {
	let total = 0;
	while (true) {
		const rows = await sql`
			SELECT id, title, author, description, genres
			FROM goodreads
			WHERE embedding IS NULL
			ORDER BY id ASC
			LIMIT 500`;

		if (rows.length === 0) break;

		for (const r of rows) {
			const text = composeEmbedText({
				title: (r.title as string) || '',
				author: (r.author as string) || '',
				description: (r.description as string) || '',
				genres: (r.genres as string) || '',
			});
			const [vec] = await embed([text]);
			const vecStr = `[${[...vec].join(',')}]`;
			await sql`UPDATE goodreads SET embedding = ${vecStr}::vector WHERE id = ${r.id}`;
			total++;
		}
	}
	return total;
};

export const runEmbedGoodreads = async (opts: {
	sql: postgres.Sql;
	limit?: number;
}) => {
	if (!isOllamaEnabled()) return { embedded: 0, missing: 0, restored: 0 };

	const { sql } = opts;

	const envLimit = Number.parseInt(process.env.LIMIT || '0', 10);
	const maxRecords = opts.limit ?? (Number.isNaN(envLimit) ? 0 : envLimit);
	const model = getEmbedModel();
	let embedded = 0;

	await sql`CREATE TABLE IF NOT EXISTS import_meta (
		key TEXT PRIMARY KEY,
		value TEXT
	)`;

	// Restore from disk cache if DB has no embeddings
	const embeddedCount =
		await sql`SELECT COUNT(*) as c FROM goodreads WHERE embedding IS NOT NULL`;
	const dbHasEmbeddings = Number(embeddedCount[0]?.c) > 0;

	let restored = 0;
	if (!dbHasEmbeddings) {
		const cache = await loadEmbeddingCache();
		const cacheIds = Object.keys(cache);
		if (cacheIds.length > 0) {
			const RESTORE_BATCH = 100;
			for (let i = 0; i < cacheIds.length; i += RESTORE_BATCH) {
				const batch = cacheIds.slice(i, i + RESTORE_BATCH);
				// biome-ignore lint/suspicious/noExplicitAny: TransactionSql missing tagged template signature
				await sql.begin(async (tx: any) => {
					for (const id of batch) {
						const vecStr = `[${cache[id].join(',')}]`;
						await tx`UPDATE goodreads SET embedding = ${vecStr}::vector WHERE id = ${Number(id)}`;
					}
				});
				restored += batch.length;
				await Bun.sleep(1);
			}
			const maxCachedId = Math.max(...cacheIds.map(Number));
			await sql`INSERT INTO import_meta (key, value) VALUES ('embeddings_last_id', ${String(maxCachedId)})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
			await sql`INSERT INTO import_meta (key, value) VALUES ('embeddings_model', ${model})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
		}
	}

	const storedModelRows =
		await sql`SELECT value FROM import_meta WHERE key = 'embeddings_model'`;
	const storedModel = storedModelRows[0]?.value as string | undefined;

	if (storedModel && storedModel !== model) {
		throw new Error(
			`Embedding model mismatch: stored="${storedModel}" current="${model}". Clear embeddings_last_id to re-embed.`,
		);
	}

	const lastIdRows =
		await sql`SELECT value FROM import_meta WHERE key = 'embeddings_last_id'`;
	let lastId = lastIdRows[0]
		? Number.parseInt(lastIdRows[0].value as string, 10)
		: 0;

	const maxRows = await sql`SELECT MAX(id) as m FROM goodreads`;
	const estimatedRemaining = (Number(maxRows[0]?.m) || 0) - lastId;

	if (estimatedRemaining <= 0) {
		const missing = await embedMissing(sql);
		await saveEmbeddingCache(sql);
		return { embedded: 0, missing, restored };
	}

	while (true) {
		if (maxRecords > 0 && embedded >= maxRecords) break;

		const batchSize =
			maxRecords > 0 ? Math.min(BATCH_SIZE, maxRecords - embedded) : BATCH_SIZE;

		const rows = await sql`
			SELECT id, title, author, description, genres
			FROM goodreads
			WHERE id > ${lastId}
			ORDER BY id ASC
			LIMIT ${batchSize}`;

		if (rows.length === 0) break;

		const batchMaxId = rows[rows.length - 1].id as number;
		const texts = rows.map((r) =>
			composeEmbedText({
				title: (r.title as string) || '',
				author: (r.author as string) || '',
				description: (r.description as string) || '',
				genres: (r.genres as string) || '',
			}),
		);

		const embeddings = await embed(texts);

		// biome-ignore lint/suspicious/noExplicitAny: TransactionSql missing tagged template signature
		await sql.begin(async (tx: any) => {
			for (let i = 0; i < rows.length; i++) {
				const vecStr = `[${[...embeddings[i]].join(',')}]`;
				await tx`UPDATE goodreads SET embedding = ${vecStr}::vector WHERE id = ${rows[i].id}`;
			}
			lastId = batchMaxId;
			await tx`INSERT INTO import_meta (key, value) VALUES ('embeddings_last_id', ${String(lastId)})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
			await tx`INSERT INTO import_meta (key, value) VALUES ('embeddings_model', ${model})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
		});

		embedded += rows.length;
		await Bun.sleep(1);
	}

	const missing = await embedMissing(sql);
	await saveEmbeddingCache(sql);

	// Create IVFFlat index if it doesn't exist (needed for fast vector search)
	// IVFFlat builds in minutes on any hardware vs HNSW which needs 50+GB RAM for 11M vectors
	const hasIndex =
		await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_goodreads_embedding'`;
	if (hasIndex.length === 0) {
		const [{ c: rowCount }] =
			await sql`SELECT COUNT(*)::int as c FROM goodreads WHERE embedding IS NOT NULL`;
		const lists = Math.max(100, Math.round(Math.sqrt(Number(rowCount))));
		console.log(
			`Creating IVFFlat vector index (${lists} lists for ${rowCount} rows)...`,
		);
		// IVFFlat k-means needs ~3GB for 11M vectors — temporarily bump maintenance_work_mem
		await sql`SET maintenance_work_mem = '4GB'`;
		await sql.unsafe(
			`CREATE INDEX idx_goodreads_embedding ON goodreads USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`,
		);
		await sql`RESET maintenance_work_mem`;
		console.log('IVFFlat index created.');
	}

	return { embedded, missing, restored };
};
