import { Database } from 'bun:sqlite';

const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';

export function runMigrateFts(opts?: { dbPath?: string }): void {
	const dbPath = opts?.dbPath ?? DB_PATH;
	const db = new Database(dbPath);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = NORMAL');

	const stored = db
		.prepare("SELECT value FROM import_meta WHERE key = 'fts_tokenizer'")
		.get() as { value: string } | undefined;

	if (stored?.value === 'porter unicode61') {
		console.log('FTS migration: already using porter tokenizer.');
		db.close();
		return;
	}

	console.log('FTS migration: rebuilding FTS tables with porter tokenizer...');
	const start = Date.now();

	db.run('DROP TABLE IF EXISTS books_fts');
	db.run(`CREATE VIRTUAL TABLE books_fts USING fts5(
  title, author, publisher, description, isbn,
  content=books,
  content_rowid=id,
  tokenize='porter unicode61'
)`);

	console.log('  Rebuilding books_fts from content table...');
	db.run("INSERT INTO books_fts(books_fts) VALUES('rebuild')");

	db.run('DROP TABLE IF EXISTS goodreads_fts');
	db.run(`CREATE VIRTUAL TABLE goodreads_fts USING fts5(
  title, author, description, genres, isbn,
  content=goodreads,
  content_rowid=id,
  tokenize='porter unicode61'
)`);

	console.log('  Rebuilding goodreads_fts from content table...');
	db.run("INSERT INTO goodreads_fts(goodreads_fts) VALUES('rebuild')");

	db.run(
		"INSERT OR REPLACE INTO import_meta (key, value) VALUES ('fts_tokenizer', 'porter unicode61')",
	);

	// Ensure extension index exists (for ?ext= filter)
	console.log('  Creating extension index if needed...');
	db.run('CREATE INDEX IF NOT EXISTS idx_books_extension ON books(extension)');

	const elapsed = ((Date.now() - start) / 1000).toFixed(0);
	console.log(`FTS migration: done in ${elapsed}s`);
	db.close();
}

if (import.meta.main) {
	runMigrateFts();
}
