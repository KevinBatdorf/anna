import { Database } from 'bun:sqlite';

const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';

export function runMigrateFts(opts?: { dbPath?: string }): void {
	const dbPath = opts?.dbPath ?? DB_PATH;
	const db = new Database(dbPath);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = NORMAL');

	// Check if import_meta table exists — if not, this is a fresh DB
	const tableExists = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='import_meta'",
		)
		.get();
	if (!tableExists) {
		console.log(
			'FTS migration: fresh database, skipping (importers will set up FTS).',
		);
		db.close();
		return;
	}

	const stored = db
		.prepare("SELECT value FROM import_meta WHERE key = 'fts_tokenizer'")
		.get() as { value: string } | undefined;

	if (stored?.value === 'porter unicode61') {
		console.log('FTS migration: already using porter tokenizer.');
		db.close();
		return;
	}

	console.log('FTS migration: recreating FTS tables with porter tokenizer...');
	const start = Date.now();

	// Drop and recreate with porter tokenizer.
	// The importers populate FTS during import, so these will be filled
	// on the next import cycle. This avoids the extremely slow
	// INSERT INTO fts(fts) VALUES('rebuild') on 100M+ row tables.
	db.run('DROP TABLE IF EXISTS books_fts');
	db.run(`CREATE VIRTUAL TABLE books_fts USING fts5(
  title, author, publisher, description, isbn,
  content=books,
  content_rowid=id,
  tokenize='porter unicode61'
)`);
	console.log('  Recreated books_fts (will be populated on next import)');

	db.run('DROP TABLE IF EXISTS goodreads_fts');
	db.run(`CREATE VIRTUAL TABLE goodreads_fts USING fts5(
  title, author, description, genres, isbn,
  content=goodreads,
  content_rowid=id,
  tokenize='porter unicode61'
)`);
	console.log('  Recreated goodreads_fts (will be populated on next import)');

	db.run(
		"INSERT OR REPLACE INTO import_meta (key, value) VALUES ('fts_tokenizer', 'porter unicode61')",
	);

	// Ensure extension index exists (for ?ext= filter)
	console.log('  Creating extension index if needed...');
	db.run('CREATE INDEX IF NOT EXISTS idx_books_extension ON books(extension)');

	const elapsed = ((Date.now() - start) / 1000).toFixed(0);
	console.log(`FTS migration: done in ${elapsed}s`);
	console.log(
		'  Note: FTS tables are empty until the next import populates them.',
	);
	db.close();
}

if (import.meta.main) {
	runMigrateFts();
}
