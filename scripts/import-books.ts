import { Database } from 'bun:sqlite';
import { readdir } from 'node:fs/promises';
import { type BookRow, parseBook } from '../src/lib/parse-books';

const DATA_DIR = process.env.DATA_DIR || '/data/torrents';
const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';

const db = new Database(DB_PATH);
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = -64000');

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

db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title, author, publisher, description, isbn,
  content=books,
  content_rowid=id
)`);

db.run(`CREATE TABLE IF NOT EXISTS import_meta (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

async function main() {
	const allFiles = await readdir(DATA_DIR);
	const downloading = new Set(
		allFiles
			.filter((f) => f.endsWith('.aria2'))
			.map((f) => f.replace(/\.aria2$/, '')),
	);

	const file = allFiles.find(
		(f) =>
			f.includes('zlib3_records') && f.endsWith('.zst') && !downloading.has(f),
	);

	if (!file) {
		console.error('No complete zlib3 data file found in', DATA_DIR);
		process.exit(1);
	}

	console.log(`Importing books from: ${file}`);
	const startTime = Date.now();

	const proc = Bun.spawn(['zstdcat', `${DATA_DIR}/${file}`], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let count = 0;
	let errors = 0;

	const insert = db.prepare(
		`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertFts = db.prepare(
		`INSERT INTO books_fts (rowid, title, author, publisher, description, isbn) VALUES (?, ?, ?, ?, ?, ?)`,
	);

	const BATCH_SIZE = 5000;
	let batch: BookRow[] = [];

	const flush = db.transaction((rows: BookRow[]) => {
		for (const row of rows) {
			const result = insert.run(...row);
			const rowid = result.lastInsertRowid;
			insertFts.run(rowid, row[2], row[3], row[4], row[10], row[12]);
		}
	});

	db.run('DELETE FROM books_fts');
	db.run('DELETE FROM books');

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;
			const row = parseBook(line);
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
	}

	if (buffer.trim()) {
		const row = parseBook(buffer);
		if (row) batch.push(row);
		else errors++;
	}
	if (batch.length > 0) {
		flush(batch);
		count += batch.length;
	}

	const elapsed = (Date.now() - startTime) / 1000;
	console.log(
		`Done: ${count.toLocaleString()} records in ${elapsed.toFixed(0)}s (${errors} errors)`,
	);

	db.run('CREATE INDEX IF NOT EXISTS idx_books_md5 ON books(md5)');
	db.run('CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn)');
	db.run('CREATE INDEX IF NOT EXISTS idx_books_language ON books(language)');
	db.run('CREATE INDEX IF NOT EXISTS idx_books_source_id ON books(source_id)');

	db.run(`INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)`, [
		'zlib3_imported_at',
		new Date().toISOString(),
	]);
	db.run(`INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)`, [
		'zlib3_file',
		file,
	]);
	db.run(`INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)`, [
		'zlib3_count',
		String(count),
	]);

	db.run('ANALYZE');
}

main();
