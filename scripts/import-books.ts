import { Database } from 'bun:sqlite';
import type { Book } from '../src/db/schema';
import { parseBook } from '../src/lib/parse-books';
import { filterNewFiles, findDataFiles } from './lib/find-data-file';

type NewBook = Omit<Book, 'id'>;

const DEFAULT_DATA_DIR = '/data/torrents';
const DEFAULT_DB_PATH = '/data/db/anna.db';

function openDb(dbPath: string) {
	const db = new Database(dbPath);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA busy_timeout = 10000');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA cache_size = -64000');
	db.run('PRAGMA mmap_size = 4294967296');

	db.run(`CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT,
  title TEXT,
  author TEXT,
  publisher TEXT,
  language TEXT,
  year TEXT,
  extension TEXT,
  filesize INTEGER,
  pages TEXT,
  description TEXT,
  md5 TEXT,
  isbn TEXT,
  series TEXT,
  edition TEXT
)`);

	db.run(
		'CREATE UNIQUE INDEX IF NOT EXISTS idx_books_source_id ON books(source_id)',
	);

	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title, author, publisher, description, isbn,
  content=books,
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
		.prepare("SELECT value FROM import_meta WHERE key = 'zlib3_imported_files'")
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
		'zlib3_imported_files',
		JSON.stringify([...files]),
	]);
}

function bookToParams(b: NewBook) {
	return [
		b.source,
		b.source_id,
		b.title,
		b.author,
		b.publisher,
		b.language,
		b.year,
		b.extension,
		b.filesize,
		b.pages,
		b.description,
		b.md5,
		b.isbn,
		b.series,
		b.edition,
	];
}

async function importFile(
	db: Database,
	dataDir: string,
	file: string,
	recordLimit: number,
): Promise<{ count: number; errors: number }> {
	console.log(`\nImporting books from: ${file}`);
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
		`INSERT OR REPLACE INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const deleteFts = db.prepare('DELETE FROM books_fts WHERE rowid = ?');
	const insertFts = db.prepare(
		'INSERT INTO books_fts (rowid, title, author, publisher, description, isbn) VALUES (?, ?, ?, ?, ?, ?)',
	);
	const findExisting = db.prepare('SELECT id FROM books WHERE source_id = ?');

	const BATCH_SIZE = 5000;
	let batch: NewBook[] = [];

	const flush = db.transaction((rows: NewBook[]) => {
		for (const row of rows) {
			const existing = findExisting.get(row.source_id) as
				| { id: number }
				| undefined;
			if (existing) {
				deleteFts.run(existing.id);
			}
			const result = upsert.run(...bookToParams(row));
			const rowid = result.lastInsertRowid;
			insertFts.run(
				rowid,
				row.title,
				row.author,
				row.publisher,
				row.description,
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
			const row = parseBook(line);
			if (row) batch.push(row);
			else errors++;

			if (batch.length >= BATCH_SIZE) {
				flush(batch);
				count += batch.length;
				batch = [];
				// Yield to event loop so the HTTP server can handle requests
				await Bun.sleep(0);
				if (count % 100_000 === 0) {
					const elapsed = (Date.now() - startTime) / 1000;
					const rate = Math.round(count / elapsed);
					console.log(
						`  ${count.toLocaleString()} records (${rate}/s, ${errors} errors)`,
					);
				}
				// Checkpoint WAL every 1M records to prevent unbounded growth
				if (count % 1_000_000 === 0) {
					db.run('PRAGMA wal_checkpoint(PASSIVE)');
				}
			}
		}
		if (recordLimit && count + batch.length >= recordLimit) break;
	}

	if (recordLimit) proc.kill();

	if (!recordLimit || count + batch.length < recordLimit) {
		if (buffer.trim()) {
			const row = parseBook(buffer);
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

export async function runImportBooks(opts?: {
	dataDir?: string;
	dbPath?: string;
	limit?: number;
}): Promise<boolean> {
	const dataDir = opts?.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
	const dbPath = opts?.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
	const recordLimit =
		opts?.limit ?? (process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0);

	const allFiles = await findDataFiles(dataDir, 'zlib3_records');
	if (allFiles.length === 0) {
		console.log('No zlib3_records data files found — skipping book import.');
		return false;
	}

	const db = openDb(dbPath);

	try {
		const importedFiles = getImportedFiles(db);
		const newFiles = filterNewFiles(allFiles, importedFiles);

		if (newFiles.length === 0) {
			console.log('Books: all files already imported, nothing to do.');
			return false;
		}

		console.log(
			`Books: ${allFiles.length} total file(s), ${newFiles.length} new to import`,
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

		db.run('CREATE INDEX IF NOT EXISTS idx_books_md5 ON books(md5)');
		db.run('CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn)');
		db.run('CREATE INDEX IF NOT EXISTS idx_books_language ON books(language)');
		db.run(
			'CREATE INDEX IF NOT EXISTS idx_books_extension ON books(extension)',
		);

		db.run('INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)', [
			'zlib3_imported_at',
			new Date().toISOString(),
		]);
		db.run('INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)', [
			'zlib3_count',
			String(
				(db.prepare('SELECT COUNT(*) as c FROM books').get() as { c: number })
					?.c ?? 0,
			),
		]);

		console.log(
			`Books done: ${totalCount.toLocaleString()} records across ${newFiles.length} file(s) (${totalErrors} errors)`,
		);

		db.run('ANALYZE');
		return true;
	} finally {
		db.close();
	}
}

// Allow running directly as a script
if (import.meta.main) {
	runImportBooks();
}
