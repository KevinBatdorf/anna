/**
 * Check if torrent data files are newer than last import, and import if so.
 * Runs once and exits — supercronic handles the schedule.
 *
 * Resume mode: if the data file hasn't changed since the last import
 * (same filename), uses INSERT ... ON CONFLICT DO NOTHING so we skip
 * already-imported rows instantly. Only does full upserts when a new
 * data file arrives from the torrent.
 */
import { readdir, stat } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runImportBooks } from './books';
import { runEmbedGoodreads } from './embed';
import { runImportGoodreads } from './goodreads';
import { createLog } from './stream';

const log = createLog('import');

const dataDir = process.env.DATA_DIR || '/data/torrents';
const dbUrl =
	process.env.DATABASE_URL || 'postgres://anna:anna@localhost:5432/anna';
const markerPath = '/data/last-import';
const limit = Number(process.env.IMPORT_LIMIT) || undefined;

// Find the newest .zst file's mtime
const allFiles = await readdir(dataDir);
const zstFiles = allFiles.filter(
	(f) => f.endsWith('.zst') && !allFiles.includes(`${f}.aria2`),
);

if (zstFiles.length === 0) {
	log('No .zst files found, nothing to import.');
	process.exit(0);
}

let newestMtime = 0;
for (const f of zstFiles) {
	const s = await stat(`${dataDir}/${f}`);
	if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs;
}

// Compare to marker
let lastImport = 0;
try {
	const s = await stat(markerPath);
	lastImport = s.mtimeMs;
} catch {
	// No marker = never imported
}

if (limit) {
	log(`IMPORT_LIMIT=${limit}, skipping mtime check.`);
} else if (newestMtime <= lastImport) {
	log('No new data since last import.');
	process.exit(0);
}

log('New data detected, starting import...');

const connection = postgres(dbUrl, { max: 5 });
const db = drizzle(connection);

// Ensure import_meta exists for storing file tracking info
await connection`CREATE TABLE IF NOT EXISTS import_meta (
	key TEXT PRIMARY KEY,
	value TEXT
)`;

/** Look up stored filename for a source, compare to current file. */
const detectResume = async (
	metaKey: string,
	filePattern: string,
): Promise<{ resume: boolean; filename: string }> => {
	const currentFile = zstFiles.find((f) => f.includes(filePattern));
	if (!currentFile) return { resume: false, filename: '' };

	const rows =
		await connection`SELECT value FROM import_meta WHERE key = ${metaKey}`;
	const storedFile = rows[0]?.value as string | undefined;

	if (storedFile === currentFile) {
		log(`${filePattern}: same file (${currentFile}), resuming`);
		return { resume: true, filename: currentFile };
	}

	if (storedFile) {
		log(
			`${filePattern}: new file (${storedFile} → ${currentFile}), full upsert`,
		);
	} else {
		log(`${filePattern}: first import (${currentFile})`);
	}
	return { resume: false, filename: currentFile };
};

/** Store the filename after successful import. */
const recordFile = async (metaKey: string, filename: string) => {
	await connection`INSERT INTO import_meta (key, value) VALUES (${metaKey}, ${filename})
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
};

const booksInfo = await detectResume('books_file', 'zlib3_records');
// Record filename before import so a crash resumes with DO NOTHING next time
if (!booksInfo.resume) await recordFile('books_file', booksInfo.filename);
try {
	await runImportBooks(dataDir, db, { limit, resume: booksInfo.resume });
} catch (e) {
	log(`Book import failed: ${e instanceof Error ? e.message : e}`);
}

const goodreadsInfo = await detectResume('goodreads_file', 'goodreads_records');
if (!goodreadsInfo.resume)
	await recordFile('goodreads_file', goodreadsInfo.filename);
try {
	await runImportGoodreads(dataDir, db, {
		limit,
		resume: goodreadsInfo.resume,
	});
} catch (e) {
	log(`Goodreads import failed: ${e instanceof Error ? e.message : e}`);
}

try {
	await runEmbedGoodreads({ sql: connection });
} catch (e) {
	log(`Embedding failed: ${e instanceof Error ? e.message : e}`);
}

await connection.end();

// Touch marker (skip for limited imports so full import still triggers)
if (!limit) await Bun.write(markerPath, new Date().toISOString());
log('Import complete.');
