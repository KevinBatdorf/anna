import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { embed, getEmbedModel, isOllamaEnabled } from '../src/lib/ollama';
import { composeEmbedText } from '../src/lib/vec-search';

export { composeEmbedText };

const DEFAULT_DB_PATH = '/data/db/anna.db';
const BATCH_SIZE = 10;

function openDb(dbPath: string): Database {
	const db = new Database(dbPath);
	sqliteVec.load(db);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA busy_timeout = 5000');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA cache_size = -64000');

	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS goodreads_vec USING vec0(
  goodreads_id INTEGER PRIMARY KEY,
  embedding FLOAT[768] DISTANCE_METRIC=cosine
)`);

	db.run(`CREATE TABLE IF NOT EXISTS import_meta (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

	return db;
}

export async function runEmbedGoodreads(opts?: {
	dbPath?: string;
	limit?: number;
}): Promise<void> {
	if (!isOllamaEnabled()) {
		console.log('OLLAMA_URL not set — skipping embedding pass.');
		return;
	}

	const dbPath = opts?.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
	const envLimit = Number.parseInt(process.env.LIMIT || '0', 10);
	const maxRecords = opts?.limit ?? (Number.isNaN(envLimit) ? 0 : envLimit);
	const model = getEmbedModel();
	const db = openDb(dbPath);

	try {
		const storedModel = db
			.prepare("SELECT value FROM import_meta WHERE key = 'embeddings_model'")
			.get() as { value: string } | undefined;

		if (storedModel?.value && storedModel.value !== model) {
			console.warn(
				`WARNING: Stored embedding model is "${storedModel.value}" but current is "${model}".`,
			);
			console.warn(
				'Skipping embedding. Clear goodreads_vec and embeddings_last_id to re-embed with new model.',
			);
			return;
		}

		const lastIdRow = db
			.prepare("SELECT value FROM import_meta WHERE key = 'embeddings_last_id'")
			.get() as { value: string } | undefined;
		let lastId = lastIdRow ? Number.parseInt(lastIdRow.value, 10) : 0;

		// Use MAX(id) to estimate remaining — COUNT(*) is too slow on 11M rows
		const maxRow = db.prepare('SELECT MAX(id) as m FROM goodreads').get() as {
			m: number | null;
		};
		const estimatedRemaining = (maxRow?.m ?? 0) - lastId;

		if (estimatedRemaining <= 0) {
			console.log('Embeddings: all records already embedded.');
			return;
		}

		const remaining =
			maxRecords > 0
				? Math.min(maxRecords, estimatedRemaining)
				: estimatedRemaining;

		console.log(
			`Embeddings: ~${remaining.toLocaleString()} records to embed (model: ${model})`,
		);

		const selectBatch = db.prepare(
			'SELECT id, title, author, description, genres FROM goodreads WHERE id > ? ORDER BY id ASC LIMIT ?',
		);
		const insertVec = db.prepare(
			'INSERT INTO goodreads_vec (goodreads_id, embedding) VALUES (?, ?)',
		);
		const updateMeta = db.prepare(
			'INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)',
		);

		let embedded = 0;
		const startTime = Date.now();

		while (true) {
			if (maxRecords > 0 && embedded >= maxRecords) break;

			const batchSize =
				maxRecords > 0
					? Math.min(BATCH_SIZE, maxRecords - embedded)
					: BATCH_SIZE;

			const rows = selectBatch.all(lastId, batchSize) as Array<{
				id: number;
				title: string;
				author: string;
				description: string;
				genres: string;
			}>;
			if (rows.length === 0) break;

			// Track the max ID in this batch so we always advance past it
			const batchMaxId = rows[rows.length - 1].id;
			const texts = rows.map(composeEmbedText);

			let embeddings: Float32Array[];
			let validRows = rows;
			try {
				embeddings = await embed(texts);
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'Unknown error';
				if (msg.includes('context length') || msg.includes('400')) {
					// Retry one-by-one to skip problematic records
					embeddings = [];
					validRows = [];
					for (let i = 0; i < rows.length; i++) {
						try {
							const [vec] = await embed([texts[i]]);
							embeddings.push(vec);
							validRows.push(rows[i]);
						} catch {
							console.warn(`  Skipped id=${rows[i].id} (input too long)`);
						}
					}
				} else {
					console.error(`Ollama error: ${msg}. Stopping embedding pass.`);
					break;
				}
			}

			db.transaction(() => {
				for (let i = 0; i < validRows.length; i++) {
					insertVec.run(validRows[i].id, embeddings[i]);
				}
				lastId = batchMaxId;
				updateMeta.run('embeddings_last_id', String(lastId));
				updateMeta.run('embeddings_model', model);
			})();

			embedded += validRows.length;

			if (embedded % 1000 === 0 || embedded === rows.length) {
				const elapsed = (Date.now() - startTime) / 1000;
				const rate = elapsed > 0 ? Math.round(embedded / elapsed) : 0;
				console.log(
					`  ${embedded.toLocaleString()} embedded (${rate}/s, last_id=${lastId})`,
				);
			}
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
		console.log(
			`Embeddings done: ${embedded.toLocaleString()} records in ${elapsed}s`,
		);
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	runEmbedGoodreads();
}
