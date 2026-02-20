import { Database } from 'bun:sqlite';
import type { Goodreads } from '../src/db/schema';
import { parseGoodreads } from '../src/lib/parse-goodreads';
import { filterNewFiles, findDataFiles } from './lib/find-data-file';

type NewGoodreads = Omit<Goodreads, 'id'>;

const DEFAULT_DATA_DIR = '/data/torrents';
const DEFAULT_DB_PATH = '/data/db/anna.db';

function openDb(dbPath: string) {
	const db = new Database(dbPath);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA busy_timeout = 10000');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA cache_size = -64000');
	db.run('PRAGMA mmap_size = 4294967296');

	db.run(`CREATE TABLE IF NOT EXISTS goodreads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  title TEXT,
  author TEXT,
  rating REAL,
  ratings_count INTEGER,
  description TEXT,
  genres TEXT,
  isbn TEXT,
  pages TEXT,
  year TEXT
)`);

	db.run(
		'CREATE UNIQUE INDEX IF NOT EXISTS idx_goodreads_source_id ON goodreads(source_id)',
	);

	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS goodreads_fts USING fts5(
  title, author, description, genres, isbn,
  content=goodreads,
  content_rowid=id,
  tokenize='porter unicode61'
)`);

	db.run(`CREATE TABLE IF NOT EXISTS import_meta (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

	// Mark FTS tokenizer so migrate-fts doesn't try to rebuild
	db.run(
		"INSERT OR IGNORE INTO import_meta (key, value) VALUES ('fts_tokenizer', 'porter unicode61')",
	);

	return db;
}

function getImportedFiles(db: Database): Set<string> {
	const row = db
		.prepare(
			"SELECT value FROM import_meta WHERE key = 'goodreads_imported_files'",
		)
		.get() as { value: string } | undefined;
	if (!row?.value) return new Set();
	try {
		return new Set(JSON.parse(row.value));
	} catch {
		return new Set();
	}
}

function saveImportedFiles(db: Database, files: Set<string>) {
	db.run('INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)', [
		'goodreads_imported_files',
		JSON.stringify([...files]),
	]);
}

function goodreadsToParams(g: NewGoodreads) {
	return [
		g.source_id,
		g.title,
		g.author,
		g.rating,
		g.ratings_count,
		g.description,
		g.genres,
		g.isbn,
		g.pages,
		g.year,
	];
}

async function importFile(
	db: Database,
	dataDir: string,
	file: string,
	recordLimit: number,
): Promise<{ count: number; errors: number }> {
	console.log(`\nImporting goodreads from: ${file}`);
	if (recordLimit) console.log(`  LIMIT: ${recordLimit} records`);
	const startTime = Date.now();

	const proc = Bun.spawn(['zstdcat', `${dataDir}/${file}`], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let count = 0;
	let errors = 0;
	let upserted = 0;

	const upsert = db.prepare(
		`INSERT OR REPLACE INTO goodreads (source_id, title, author, rating, ratings_count, description, genres, isbn, pages, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const deleteFts = db.prepare('DELETE FROM goodreads_fts WHERE rowid = ?');
	const insertFts = db.prepare(
		'INSERT INTO goodreads_fts (rowid, title, author, description, genres, isbn) VALUES (?, ?, ?, ?, ?, ?)',
	);
	const findExisting = db.prepare(
		'SELECT id FROM goodreads WHERE source_id = ?',
	);

	const BATCH_SIZE = 5000;
	let batch: NewGoodreads[] = [];

	const flush = db.transaction((rows: NewGoodreads[]) => {
		for (const row of rows) {
			const existing = findExisting.get(row.source_id) as
				| { id: number }
				| undefined;
			if (existing) {
				deleteFts.run(existing.id);
			}
			const result = upsert.run(...goodreadsToParams(row));
			const rowid = result.lastInsertRowid;
			insertFts.run(
				rowid,
				row.title,
				row.author,
				row.description,
				row.genres,
				row.isbn,
			);
			upserted++;
		}
	});

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;
			if (recordLimit && count + batch.length >= recordLimit) break;
			const row = parseGoodreads(line);
			if (row) batch.push(row);
			else errors++;

			if (batch.length >= BATCH_SIZE) {
				flush(batch);
				count += batch.length;
				batch = [];
				if (count % 100_000 === 0) {
					const elapsed = (Date.now() - startTime) / 1000;
					const rate = Math.round(count / elapsed);
					console.log(
						`  ${count.toLocaleString()} records (${rate}/s, ${errors} errors)`,
					);
				}
			}
		}
		if (recordLimit && count + batch.length >= recordLimit) break;
	}

	if (recordLimit) proc.kill();

	if (!recordLimit || count + batch.length < recordLimit) {
		if (buffer.trim()) {
			const row = parseGoodreads(buffer);
			if (row) batch.push(row);
			else errors++;
		}
	}
	if (batch.length > 0) {
		flush(batch);
		count += batch.length;
	}

	const elapsed = (Date.now() - startTime) / 1000;
	console.log(
		`  Done: ${count.toLocaleString()} records in ${elapsed.toFixed(0)}s (${upserted} upserted, ${errors} errors)`,
	);

	return { count, errors };
}

export async function runImportGoodreads(opts?: {
	dataDir?: string;
	dbPath?: string;
	limit?: number;
}): Promise<boolean> {
	const dataDir = opts?.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
	const dbPath = opts?.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
	const recordLimit =
		opts?.limit ?? (process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0);

	const allFiles = await findDataFiles(dataDir, 'goodreads_records');
	if (allFiles.length === 0) {
		console.log(
			'No goodreads_records data files found — skipping goodreads import.',
		);
		return false;
	}

	const db = openDb(dbPath);

	try {
		const importedFiles = getImportedFiles(db);
		const newFiles = filterNewFiles(allFiles, importedFiles);

		if (newFiles.length === 0) {
			console.log('Goodreads: all files already imported, nothing to do.');
			return false;
		}

		console.log(
			`Goodreads: ${allFiles.length} total file(s), ${newFiles.length} new to import`,
		);

		let totalCount = 0;
		let totalErrors = 0;

		for (const file of newFiles) {
			const { count, errors } = await importFile(
				db,
				dataDir,
				file,
				recordLimit,
			);
			totalCount += count;
			totalErrors += errors;

			importedFiles.add(file);
			saveImportedFiles(db, importedFiles);
		}

		db.run('CREATE INDEX IF NOT EXISTS idx_goodreads_isbn ON goodreads(isbn)');

		db.run('INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)', [
			'goodreads_imported_at',
			new Date().toISOString(),
		]);
		db.run('INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)', [
			'goodreads_count',
			String(
				(
					db.prepare('SELECT COUNT(*) as c FROM goodreads').get() as {
						c: number;
					}
				)?.c ?? 0,
			),
		]);

		console.log(
			`Goodreads done: ${totalCount.toLocaleString()} records across ${newFiles.length} file(s) (${totalErrors} errors)`,
		);

		db.run('ANALYZE');
		return true;
	} finally {
		db.close();
	}
}

// Allow running directly as a script
if (import.meta.main) {
	runImportGoodreads();
}
