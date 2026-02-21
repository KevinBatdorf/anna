/**
 * Check if torrent data files are newer than last import, and import if so.
 * Runs once and exits — supercronic handles the schedule.
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
const files = await readdir(dataDir);
const zstFiles = files.filter((f) => f.endsWith('.zst'));

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

try {
	await runImportBooks(dataDir, db, limit);
} catch (e) {
	log(`Book import failed: ${e instanceof Error ? e.message : e}`);
}

try {
	await runImportGoodreads(dataDir, db, limit);
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
