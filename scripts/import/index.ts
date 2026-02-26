/**
 * Import .zst data files into Postgres.
 * Runs once and exits — supercronic handles the schedule.
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runImportBooks } from './books';
import { runEmbedGoodreads } from './embed';
import { runImportGoodreads } from './goodreads';

const baseDir = `${import.meta.dirname}/../../data`;
const statusPath = `${baseDir}/import-status.json`;

interface ImportStatus {
	started_at: string;
	finished_at: string | null;
	error: string | null;
	books: { file: string; count: number; resumed: boolean } | null;
	goodreads: { count: number } | null;
	embeddings: { embedded: number; missing: number; restored: number } | null;
}

const status: ImportStatus = {
	started_at: new Date().toISOString(),
	finished_at: null,
	error: null,
	books: null,
	goodreads: null,
	embeddings: null,
};

const saveStatus = () => {
	writeFileSync(statusPath, JSON.stringify(status, null, '\t'));
};

const dataDir = process.env.DATA_DIR || `${baseDir}/torrents`;
const dbUrl =
	process.env.DATABASE_URL || 'postgres://anna:anna@localhost:5432/anna';
const lockPath = `${baseDir}/import.lock`;
const markerPath = `${baseDir}/last-import`;
const limit = Number(process.env.IMPORT_LIMIT) || undefined;

// ── Lock: prevent concurrent imports ──
if (existsSync(lockPath)) {
	const pid = Number(await Bun.file(lockPath).text());
	try {
		process.kill(pid, 0);
		process.exit(0);
	} catch (e: unknown) {
		if (e instanceof Error && 'code' in e && e.code !== 'ESRCH') throw e;
		unlinkSync(lockPath);
	}
}
writeFileSync(lockPath, String(process.pid));
const removeLock = () => {
	try {
		unlinkSync(lockPath);
	} catch (e: unknown) {
		if (e instanceof Error && 'code' in e && e.code !== 'ENOENT') throw e;
	}
};
process.on('exit', removeLock);
process.on('SIGTERM', () => {
	removeLock();
	process.exit(0);
});

// ── Check for new data ──
const allFiles = await readdir(dataDir);
const zstFiles = allFiles.filter(
	(f) => f.endsWith('.zst') && !allFiles.includes(`${f}.aria2`),
);

if (zstFiles.length === 0) process.exit(0);

let newestMtime = 0;
for (const f of zstFiles) {
	const s = await stat(`${dataDir}/${f}`);
	if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs;
}

const connection = postgres(dbUrl, { max: 5 });
const db = drizzle(connection);

// Wait for postgres to be ready (startup race with Docker)
for (let attempt = 0; ; attempt++) {
	try {
		await connection`SELECT 1`;
		break;
	} catch (e) {
		if (attempt >= 15) throw e;
		await new Promise((r) => setTimeout(r, 2000));
	}
}

// Check if books import is incomplete (crashed mid-way)
// Only relevant if books_done is not set — import_line is a books resume cursor
const [metaBooksDone, metaImportLine] = await Promise.all([
	connection`SELECT value FROM import_meta WHERE key = 'books_done'`,
	connection`SELECT value FROM import_meta WHERE key = 'import_line'`,
]);
const importIncomplete =
	metaBooksDone[0]?.value !== 'true' && Number(metaImportLine[0]?.value) > 0;

// Check if data files changed since last successful run
let dataChanged = importIncomplete;
if (!dataChanged) {
	let lastImport = 0;
	try {
		const s = await stat(markerPath);
		lastImport = s.mtimeMs;
	} catch (e: unknown) {
		if (e instanceof Error && 'code' in e && e.code !== 'ENOENT') throw e;
	}
	dataChanged = newestMtime > lastImport;
	// New data files — reset done flags so they get re-imported
	if (dataChanged)
		await connection`DELETE FROM import_meta WHERE key IN ('books_done', 'goodreads_done')`;
}

// Check if embeddings still need work
const embeddingsIncomplete =
	process.env.OLLAMA_URL &&
	(
		await connection`SELECT EXISTS(SELECT 1 FROM goodreads WHERE embedding IS NULL) as e`
	)[0]?.e;

if (!dataChanged && !embeddingsIncomplete) {
	await connection.end();
	process.exit(0);
}

const saveMeta = (key: string, value: string) =>
	connection`INSERT INTO import_meta (key, value) VALUES (${key}, ${value})
		ON CONFLICT (key) DO UPDATE SET value = ${value}`;

saveStatus();
await saveMeta('import_started', status.started_at);
await saveMeta('import_finished', '');
await saveMeta('import_error', '');

try {
	if (dataChanged) {
		// Skip books if already completed for this data file
		const booksDone = (
			await connection`SELECT value FROM import_meta WHERE key = 'books_done'`
		)[0]?.value;
		if (booksDone !== 'true') {
			const [{ c: bookCount }] =
				await connection`SELECT COALESCE(MAX(id), 0)::int as c FROM books`;
			const booksRemaining = limit ? limit - Number(bookCount) : undefined;
			if (booksRemaining === undefined || booksRemaining > 0) {
				status.books = await runImportBooks(dataDir, db, {
					limit: booksRemaining,
				});
				saveStatus();
			}
			// Reset sequence + store actual count
			await connection`SELECT setval('books_id_seq', COALESCE((SELECT MAX(id) FROM books), 1))`;
			const [{ c: bc }] =
				await connection`SELECT COUNT(*)::int as c FROM books`;
			await saveMeta('books_count', String(bc));
			if (!limit) await saveMeta('books_done', 'true');
		}

		// Skip goodreads if already completed for this data file
		const grDone = (
			await connection`SELECT value FROM import_meta WHERE key = 'goodreads_done'`
		)[0]?.value;
		if (grDone !== 'true') {
			status.goodreads = await runImportGoodreads(dataDir, db, {
				limit,
				onBatch: async (count) => {
					await saveMeta('goodreads_count', String(count));
				},
			});
			saveStatus();
			// Reset sequence + store actual count
			await connection`SELECT setval('goodreads_id_seq', COALESCE((SELECT MAX(id) FROM goodreads), 1))`;
			const [{ c: gc }] =
				await connection`SELECT COUNT(*)::int as c FROM goodreads`;
			await saveMeta('goodreads_count', String(gc));
			if (!limit) await saveMeta('goodreads_done', 'true');
		}

		if (!limit) await Bun.write(markerPath, new Date().toISOString());
	}

	status.embeddings = await runEmbedGoodreads({ sql: connection });
	saveStatus();
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	// Truncate error — the full SQL + params can be megabytes
	const shortMsg = msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
	console.error(`Import failed: ${shortMsg}`);
	status.error = msg;
	status.finished_at = new Date().toISOString();
	saveStatus();
	await saveMeta('import_finished', status.finished_at);
	await saveMeta('import_error', shortMsg);
	await connection.end();
	throw e;
}

status.finished_at = new Date().toISOString();
await saveMeta('import_finished', status.finished_at);
saveStatus();
await connection.end();
