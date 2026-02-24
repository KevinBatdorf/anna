import { readdir } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Book } from '../../src/db/schema';
import { books, importMeta } from '../../src/db/schema';
import { streamImport } from './stream';

/** Strip null bytes, replacement chars, lone surrogates, and C1 control chars */
const clean = (s: string | null) =>
	(s ?? '')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional cleanup
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, '')
		.replace(/[\uD800-\uDFFF]/g, '');

type BookInsert = Omit<Book, 'id' | 'search' | 'created_at' | 'updated_at'>;

export const parseBook = (line: string): BookInsert | null => {
	const obj = JSON.parse(line);
	const m = (obj.metadata ?? obj) as Record<string, string | number | string[]>;
	const title = String(m.title ?? '').trim();
	// Source data has many empty records (no title, author, or any fields); skip them.
	// Note: source_id may also be empty on these junk records.
	if (!title) return null;
	return {
		source: 'zlib3',
		source_id: String(m.zlibrary_id ?? m.z_library_id ?? ''),
		title,
		author: String(m.author ?? ''),
		publisher: String(m.publisher ?? ''),
		language: String(m.language ?? ''),
		year: String(m.year ?? ''),
		extension: String(m.extension ?? ''),
		filesize: Number(m.filesize_reported ?? m.filesize ?? 0),
		pages: String(m.pages ?? ''),
		description: String(m.description ?? ''),
		md5: String(m.md5_reported ?? m.md5 ?? ''),
		isbn: Array.isArray(m.isbns)
			? String(m.isbns[0] ?? '')
			: String(m.isbn ?? ''),
		series: String(m.series ?? ''),
		edition: String(m.edition ?? ''),
	};
};

const cleanValues = (b: BookInsert) => ({
	source: b.source,
	source_id: b.source_id ?? '',
	title: clean(b.title),
	author: clean(b.author),
	publisher: clean(b.publisher),
	language: b.language,
	year: b.year,
	extension: b.extension,
	filesize: b.filesize,
	pages: b.pages,
	description: clean(b.description),
	md5: b.md5,
	isbn: b.isbn,
	series: clean(b.series),
	edition: clean(b.edition),
});

const dedupe = (batch: BookInsert[]) => {
	const seen = new Map<string, BookInsert>();
	for (const b of batch) seen.set(b.source_id ?? '', b);
	return [...seen.values()];
};

/**
 * Detect Postgres encoding errors (code 22021).
 * Drizzle wraps these as "Failed query: ..." and stashes the original
 * PostgresError on .cause or keeps the code on the error itself.
 */
const isEncodingError = (e: unknown): boolean => {
	if (!(e instanceof Error)) return false;
	// Direct postgres.js error
	if ('code' in e && (e as Record<string, unknown>).code === '22021')
		return true;
	// Check message for the postgres error text
	if (e.message.includes('invalid byte sequence')) return true;
	// Drizzle wraps: check cause
	const cause = 'cause' in e ? (e as Record<string, unknown>).cause : null;
	if (cause instanceof Error) return isEncodingError(cause);
	return false;
};

/** Only update when at least one column actually changed */
const booksConflictWhere = sql`
	${books.title} IS DISTINCT FROM excluded.title
	OR ${books.author} IS DISTINCT FROM excluded.author
	OR ${books.publisher} IS DISTINCT FROM excluded.publisher
	OR ${books.language} IS DISTINCT FROM excluded.language
	OR ${books.year} IS DISTINCT FROM excluded.year
	OR ${books.extension} IS DISTINCT FROM excluded.extension
	OR ${books.filesize} IS DISTINCT FROM excluded.filesize
	OR ${books.pages} IS DISTINCT FROM excluded.pages
	OR ${books.description} IS DISTINCT FROM excluded.description
	OR ${books.md5} IS DISTINCT FROM excluded.md5
	OR ${books.isbn} IS DISTINCT FROM excluded.isbn
	OR ${books.series} IS DISTINCT FROM excluded.series
	OR ${books.edition} IS DISTINCT FROM excluded.edition
`;

const booksConflictSet = {
	title: sql.raw('excluded.title'),
	author: sql.raw('excluded.author'),
	publisher: sql.raw('excluded.publisher'),
	language: sql.raw('excluded.language'),
	year: sql.raw('excluded.year'),
	extension: sql.raw('excluded.extension'),
	filesize: sql.raw('excluded.filesize'),
	pages: sql.raw('excluded.pages'),
	description: sql.raw('excluded.description'),
	md5: sql.raw('excluded.md5'),
	isbn: sql.raw('excluded.isbn'),
	series: sql.raw('excluded.series'),
	edition: sql.raw('excluded.edition'),
	updated_at: sql`now()`,
};

const upsertOne = (db: PostgresJsDatabase, row: BookInsert) =>
	db.insert(books).values(cleanValues(row)).onConflictDoUpdate({
		target: books.source_id,
		set: booksConflictSet,
		where: booksConflictWhere,
	});

/**
 * On encoding errors, retry row-by-row and skip any that still fail.
 * This works around a Bun-on-Linux issue where certain characters produce
 * invalid UTF-8 wire bytes through postgres.js batch inserts.
 */
async function retryRowByRow(
	db: PostgresJsDatabase,
	batch: BookInsert[],
	fn: (db: PostgresJsDatabase, row: BookInsert) => Promise<unknown>,
) {
	let skipped = 0;
	for (const row of batch) {
		try {
			await fn(db, row);
		} catch (e) {
			if (isEncodingError(e)) {
				skipped++;
				continue;
			}
			throw e;
		}
	}
	if (skipped > 0) console.log(`Skipped ${skipped} rows with encoding errors`);
}

const upsertBooks = async (db: PostgresJsDatabase, batch: BookInsert[]) => {
	const values = dedupe(batch).map(cleanValues);
	try {
		await db.insert(books).values(values).onConflictDoUpdate({
			target: books.source_id,
			set: booksConflictSet,
			where: booksConflictWhere,
		});
	} catch (e) {
		if (!isEncodingError(e)) throw e;
		await retryRowByRow(db, dedupe(batch), upsertOne);
	}
};

const insertOne = (db: PostgresJsDatabase, row: BookInsert) =>
	db.insert(books).values(cleanValues(row)).onConflictDoNothing();

const insertBooks = async (db: PostgresJsDatabase, batch: BookInsert[]) => {
	const values = dedupe(batch).map(cleanValues);
	try {
		await db.insert(books).values(values).onConflictDoNothing();
	} catch (e) {
		if (!isEncodingError(e)) throw e;
		await retryRowByRow(db, dedupe(batch), insertOne);
	}
};

const saveMeta = async (db: PostgresJsDatabase, key: string, value: string) => {
	await db
		.insert(importMeta)
		.values({ key, value })
		.onConflictDoUpdate({ target: importMeta.key, set: { value } });
};

const getMeta = async (db: PostgresJsDatabase, key: string) => {
	const rows = await db
		.select()
		.from(importMeta)
		.where(eq(importMeta.key, key));
	return rows[0]?.value ?? null;
};

export const runImportBooks = async (
	dataDir: string,
	db: PostgresJsDatabase,
	opts?: { limit?: number },
) => {
	const lastFile = await getMeta(db, 'import_file');
	const lastLine = Number(await getMeta(db, 'import_line')) || 0;
	const lastCount = Number(await getMeta(db, 'books_count')) || 0;

	const allFiles = await readdir(dataDir);
	const zstFiles = allFiles.filter(
		(f) =>
			f.includes('zlib3_records') &&
			f.endsWith('.zst') &&
			!allFiles.includes(`${f}.aria2`),
	);
	if (zstFiles.length !== 1)
		throw new Error(`Expected 1 zlib3_records file, found ${zstFiles.length}`);
	const currentFile = zstFiles[0];

	const resume = currentFile === lastFile && lastLine > 0;

	const { file, count } = await streamImport(dataDir, {
		filePattern: 'zlib3_records',
		parse: parseBook,
		insert: resume
			? (batch) => insertBooks(db, batch)
			: (batch) => upsertBooks(db, batch),
		skip: resume ? lastLine : 0,
		onBatch: async (linesProcessed, batchCount) => {
			await saveMeta(db, 'import_file', currentFile);
			await saveMeta(db, 'import_line', String(linesProcessed));
			await saveMeta(
				db,
				'books_count',
				String((resume ? lastCount : 0) + batchCount),
			);
		},
		limit: opts?.limit,
	});

	if (!opts?.limit) {
		await saveMeta(db, 'import_file', '');
		await saveMeta(db, 'import_line', '0');
	}
	return { file, count, resumed: resume };
};
