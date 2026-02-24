import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { XMLParser } from 'fast-xml-parser';
import type { Goodreads } from '../../src/db/schema';
import { goodreads } from '../../src/db/schema';
import { streamImport } from './stream';

/** Scrub any bytes Postgres will reject (bad UTF-8, null bytes, lone surrogates) */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
const clean = (s: string | null) =>
	decoder
		.decode(encoder.encode(s ?? ''))
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional cleanup
		.replace(/[\x00\uFFFD]/g, '');

type GoodreadsInsert = Omit<
	Goodreads,
	'id' | 'search' | 'embedding' | 'created_at' | 'updated_at'
>;

const parser = new XMLParser({ processEntities: false });

const tag = (parsed: Record<string, unknown>, key: string): string =>
	String(parsed[key] ?? '').trim();

export const parseGoodreads = (line: string): GoodreadsInsert | null => {
	const obj = JSON.parse(line);
	const meta = obj.metadata as Record<string, unknown> | undefined;
	const xml = String(meta?.record ?? '');
	if (!xml) return null;

	const doc = parser.parse(xml) as Record<string, unknown>;
	const gr = doc.GoodreadsResponse as Record<string, unknown> | undefined;
	const root = (gr?.book ?? doc.book ?? doc) as Record<string, unknown>;

	const title = tag(root, 'title_without_series') || tag(root, 'title');
	const rating = Number.parseFloat(tag(root, 'average_rating')) || null;
	const ratingsCount = Number.parseInt(tag(root, 'ratings_count'), 10) || 0;

	const authors = root.authors as Record<string, unknown> | undefined;
	const authorList = Array.isArray(authors?.author)
		? authors.author
		: [authors?.author].filter(Boolean);
	const author = String(
		(authorList[0] as Record<string, unknown>)?.name ?? '',
	).trim();

	return {
		source_id: String(meta?.id ?? ''),
		title,
		author,
		rating,
		ratings_count: ratingsCount,
		description: tag(root, 'description'),
		genres: '',
		isbn: tag(root, 'isbn13') || tag(root, 'isbn'),
		pages: tag(root, 'num_pages'),
		year: tag(root, 'publication_year'),
	};
};

/**
 * Detect Postgres encoding errors (code 22021).
 * Drizzle wraps these as "Failed query: ..." and stashes the original
 * PostgresError on .cause or keeps the code on the error itself.
 */
const isEncodingError = (e: unknown): boolean => {
	if (!(e instanceof Error)) return false;
	if ('code' in e && (e as Record<string, unknown>).code === '22021')
		return true;
	if (e.message.includes('invalid byte sequence')) return true;
	const cause = 'cause' in e ? (e as Record<string, unknown>).cause : null;
	if (cause instanceof Error) return isEncodingError(cause);
	return false;
};

const cleanGr = (b: GoodreadsInsert) => ({
	source_id: b.source_id,
	title: clean(b.title),
	author: clean(b.author),
	rating: b.rating,
	ratings_count: b.ratings_count,
	description: clean(b.description),
	genres: clean(b.genres),
	isbn: b.isbn,
	pages: b.pages,
	year: b.year,
});

const grConflictSet = {
	title: sql.raw('excluded.title'),
	author: sql.raw('excluded.author'),
	rating: sql.raw('excluded.rating'),
	ratings_count: sql.raw('excluded.ratings_count'),
	description: sql.raw('excluded.description'),
	genres: sql.raw('excluded.genres'),
	isbn: sql.raw('excluded.isbn'),
	pages: sql.raw('excluded.pages'),
	year: sql.raw('excluded.year'),
	embedding: sql`CASE WHEN
		${goodreads.title} IS DISTINCT FROM excluded.title
		OR ${goodreads.author} IS DISTINCT FROM excluded.author
		OR ${goodreads.description} IS DISTINCT FROM excluded.description
		THEN NULL ELSE ${goodreads.embedding} END`,
	updated_at: sql`now()`,
};

/** Only update when at least one column actually changed */
const grConflictWhere = sql`
	${goodreads.title} IS DISTINCT FROM excluded.title
	OR ${goodreads.author} IS DISTINCT FROM excluded.author
	OR ${goodreads.rating} IS DISTINCT FROM excluded.rating
	OR ${goodreads.ratings_count} IS DISTINCT FROM excluded.ratings_count
	OR ${goodreads.description} IS DISTINCT FROM excluded.description
	OR ${goodreads.genres} IS DISTINCT FROM excluded.genres
	OR ${goodreads.isbn} IS DISTINCT FROM excluded.isbn
	OR ${goodreads.pages} IS DISTINCT FROM excluded.pages
	OR ${goodreads.year} IS DISTINCT FROM excluded.year
`;

const upsertGoodreads = async (
	db: PostgresJsDatabase,
	batch: GoodreadsInsert[],
) => {
	const seen = new Map<string, GoodreadsInsert>();
	for (const b of batch) seen.set(b.source_id ?? '', b);
	const unique = [...seen.values()];

	try {
		await db.insert(goodreads).values(unique.map(cleanGr)).onConflictDoUpdate({
			target: goodreads.source_id,
			set: grConflictSet,
			where: grConflictWhere,
		});
	} catch (e) {
		if (!isEncodingError(e)) throw e;
		let skipped = 0;
		for (const row of unique) {
			try {
				await db.insert(goodreads).values(cleanGr(row)).onConflictDoUpdate({
					target: goodreads.source_id,
					set: grConflictSet,
					where: grConflictWhere,
				});
			} catch (e2) {
				if (isEncodingError(e2)) {
					skipped++;
					continue;
				}
				throw e2;
			}
		}
		if (skipped > 0)
			console.log(`Skipped ${skipped} goodreads rows with encoding errors`);
	}
};

export const runImportGoodreads = async (
	dataDir: string,
	db: PostgresJsDatabase,
	opts?: { limit?: number; onBatch?: (count: number) => Promise<void> },
) => {
	const { count } = await streamImport(dataDir, {
		filePattern: 'goodreads_records',
		parse: parseGoodreads,
		insert: (batch) => upsertGoodreads(db, batch),
		onBatch: opts?.onBatch
			? async (_line, c) => {
					await opts.onBatch?.(c);
				}
			: undefined,
		limit: opts?.limit,
	});
	return { count };
};
