import type postgres from 'postgres';
import { embed, getEmbedModel, isOllamaEnabled } from '../../src/lib/ollama';
import { composeEmbedText } from '../../src/lib/vec-search';
import { createLog, logDir } from './stream';

const BATCH_SIZE = 10;
const CACHE_PATH = `${logDir}/embeddings-cache.json`;

const log = createLog('embed-goodreads');

const loadEmbeddingCache = async (): Promise<Record<string, number[]>> => {
	try {
		const file = Bun.file(CACHE_PATH);
		if (await file.exists()) {
			const data = await file.json();
			const count = Object.keys(data).length;
			log(`Loaded ${count.toLocaleString()} cached embeddings from disk`);
			return data;
		}
	} catch (e) {
		log(`Could not load embedding cache: ${e}`);
	}
	return {};
};

const saveEmbeddingCache = async (sql: postgres.Sql) => {
	try {
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
		log(`Saved ${rows.length.toLocaleString()} embeddings to cache`);
	} catch (e) {
		log(`Could not save embedding cache: ${e}`);
	}
};

export const runEmbedGoodreads = async (opts: {
	sql: postgres.Sql;
	limit?: number;
}) => {
	if (!isOllamaEnabled()) {
		log('OLLAMA_URL not set — skipping embedding pass.');
		return;
	}

	const { sql } = opts;

	const envLimit = Number.parseInt(process.env.LIMIT || '0', 10);
	const maxRecords = opts.limit ?? (Number.isNaN(envLimit) ? 0 : envLimit);
	const model = getEmbedModel();
	let embedded = 0;

	// Ensure import_meta table exists
	await sql`CREATE TABLE IF NOT EXISTS import_meta (
		key TEXT PRIMARY KEY,
		value TEXT
	)`;

	// --- Restore from disk cache if DB has no embeddings ---
	const embeddedCount =
		await sql`SELECT COUNT(*) as c FROM goodreads WHERE embedding IS NOT NULL`;
	const dbHasEmbeddings = Number(embeddedCount[0]?.c) > 0;

	if (!dbHasEmbeddings) {
		const cache = await loadEmbeddingCache();
		const cacheIds = Object.keys(cache);
		if (cacheIds.length > 0) {
			log(
				`Restoring ${cacheIds.length.toLocaleString()} embeddings from cache...`,
			);
			const RESTORE_BATCH = 100;
			let restored = 0;
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
				if (restored % 1000 === 0) {
					log(`  Restored ${restored.toLocaleString()}...`);
				}
				await Bun.sleep(1);
			}
			const maxCachedId = Math.max(...cacheIds.map(Number));
			await sql`INSERT INTO import_meta (key, value) VALUES ('embeddings_last_id', ${String(maxCachedId)})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
			await sql`INSERT INTO import_meta (key, value) VALUES ('embeddings_model', ${model})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
			log(
				`Restored ${restored.toLocaleString()} embeddings from cache (last_id=${maxCachedId})`,
			);
		}
	}

	const storedModelRows =
		await sql`SELECT value FROM import_meta WHERE key = 'embeddings_model'`;
	const storedModel = storedModelRows[0]?.value as string | undefined;

	if (storedModel && storedModel !== model) {
		log(
			`WARNING: Stored embedding model is "${storedModel}" but current is "${model}".`,
		);
		log(
			'Skipping embedding. Clear embeddings and embeddings_last_id to re-embed with new model.',
		);
		return;
	}

	const lastIdRows =
		await sql`SELECT value FROM import_meta WHERE key = 'embeddings_last_id'`;
	let lastId = lastIdRows[0]
		? Number.parseInt(lastIdRows[0].value as string, 10)
		: 0;

	const maxRows = await sql`SELECT MAX(id) as m FROM goodreads`;
	const estimatedRemaining = (Number(maxRows[0]?.m) || 0) - lastId;

	if (estimatedRemaining <= 0) {
		log('Embeddings: all records already embedded.');
		return;
	}

	const remaining =
		maxRecords > 0
			? Math.min(maxRecords, estimatedRemaining)
			: estimatedRemaining;

	log(
		`Embeddings: ~${remaining.toLocaleString()} records to embed (model: ${model})`,
	);

	const startTime = Date.now();

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

		let embeddings: Float32Array[];
		let validRows = [...rows];
		try {
			embeddings = await embed(texts);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			if (msg.includes('context length') || msg.includes('400')) {
				embeddings = [];
				validRows = [];
				for (let i = 0; i < rows.length; i++) {
					try {
						const [vec] = await embed([texts[i]]);
						embeddings.push(vec);
						validRows.push(rows[i]);
					} catch {
						log(`  Skipped id=${rows[i].id} (input too long)`);
					}
				}
			} else {
				log(`Ollama error: ${msg}. Stopping embedding pass.`);
				break;
			}
		}

		// biome-ignore lint/suspicious/noExplicitAny: TransactionSql missing tagged template signature
		await sql.begin(async (tx: any) => {
			for (let i = 0; i < validRows.length; i++) {
				const vecStr = `[${[...embeddings[i]].join(',')}]`;
				await tx`UPDATE goodreads SET embedding = ${vecStr}::vector WHERE id = ${validRows[i].id}`;
			}
			lastId = batchMaxId;
			await tx`INSERT INTO import_meta (key, value) VALUES ('embeddings_last_id', ${String(lastId)})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
			await tx`INSERT INTO import_meta (key, value) VALUES ('embeddings_model', ${model})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
		});

		embedded += validRows.length;

		await Bun.sleep(1);

		if (embedded % 1000 === 0 || embedded === rows.length) {
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = elapsed > 0 ? Math.round(embedded / elapsed) : 0;
			log(
				`  ${embedded.toLocaleString()} embedded (${rate}/s, last_id=${lastId})`,
			);
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
	log(`Embeddings done: ${embedded.toLocaleString()} records in ${elapsed}s`);

	await saveEmbeddingCache(sql);
};
