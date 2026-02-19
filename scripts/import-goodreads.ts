import { Database } from 'bun:sqlite';
import { readdir } from 'node:fs/promises';
import { type GoodreadsRow, parseGoodreads } from '../src/lib/parse-goodreads';

const DATA_DIR = process.env.DATA_DIR || '/data/torrents';
const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';
const RECORD_LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;

const db = new Database(DB_PATH);
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = -64000');

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

db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS goodreads_fts USING fts5(
  title, author, description, genres, isbn,
  content=goodreads,
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
			f.includes('goodreads_records') &&
			f.endsWith('.zst') &&
			!downloading.has(f),
	);

	if (!file) {
		console.error('No complete goodreads data file found in', DATA_DIR);
		process.exit(1);
	}

	console.log(`Importing goodreads from: ${file}`);
	if (RECORD_LIMIT) console.log(`  LIMIT: ${RECORD_LIMIT} records`);
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
		`INSERT INTO goodreads (source_id, title, author, rating, ratings_count, description, genres, isbn, pages, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertFts = db.prepare(
		`INSERT INTO goodreads_fts (rowid, title, author, description, genres, isbn) VALUES (?, ?, ?, ?, ?, ?)`,
	);

	const BATCH_SIZE = 5000;
	let batch: GoodreadsRow[] = [];

	const flush = db.transaction((rows: GoodreadsRow[]) => {
		for (const row of rows) {
			const result = insert.run(...row);
			const rowid = result.lastInsertRowid;
			insertFts.run(rowid, row[1], row[2], row[5], row[6], row[7]);
		}
	});

	db.run('DELETE FROM goodreads_fts');
	db.run('DELETE FROM goodreads');

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;
			if (RECORD_LIMIT && count + batch.length >= RECORD_LIMIT) break;
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
		if (RECORD_LIMIT && count + batch.length >= RECORD_LIMIT) break;
	}

	if (RECORD_LIMIT) proc.kill();

	if (!RECORD_LIMIT || count + batch.length < RECORD_LIMIT) {
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
		`Done: ${count.toLocaleString()} records in ${elapsed.toFixed(0)}s (${errors} errors)`,
	);

	db.run('CREATE INDEX IF NOT EXISTS idx_goodreads_isbn ON goodreads(isbn)');
	db.run(
		'CREATE INDEX IF NOT EXISTS idx_goodreads_source_id ON goodreads(source_id)',
	);

	db.run(`INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)`, [
		'goodreads_imported_at',
		new Date().toISOString(),
	]);
	db.run(`INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)`, [
		'goodreads_file',
		file,
	]);
	db.run(`INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)`, [
		'goodreads_count',
		String(count),
	]);

	db.run('ANALYZE');
}

main();
