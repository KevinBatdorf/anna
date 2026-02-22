import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Goodreads } from '../../src/db/schema';
import { goodreads } from '../../src/db/schema';
import { clean, createLog, streamImport } from './stream';

type NewGoodreads = Omit<Goodreads, 'id' | 'search' | 'embedding'>;

export const xmlTag = (xml: string, tag: string): string => {
	const re = new RegExp(
		`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`,
		's',
	);
	const m = re.exec(xml);
	return m ? m[1].trim() : '';
};

export const parseGoodreads = (line: string): NewGoodreads | null => {
	const obj = JSON.parse(line);
	const meta = obj.metadata;
	const xml: string = meta?.record ?? '';
	if (!xml) return null;

	const title = xmlTag(xml, 'title_without_series') || xmlTag(xml, 'title');
	const rating = Number.parseFloat(xmlTag(xml, 'average_rating')) || null;
	const ratingsCount = Number.parseInt(xmlTag(xml, 'ratings_count'), 10) || 0;

	const authorMatch =
		/<authors>[\s\S]*?<author>[\s\S]*?<name>(.*?)<\/name>/s.exec(xml);
	const author = authorMatch ? authorMatch[1].trim() : '';

	return {
		source_id: String(meta.id ?? ''),
		title,
		author,
		rating,
		ratings_count: ratingsCount,
		description: xmlTag(xml, 'description'),
		genres: '',
		isbn: xmlTag(xml, 'isbn13') || xmlTag(xml, 'isbn'),
		pages: xmlTag(xml, 'num_pages'),
		year: xmlTag(xml, 'publication_year'),
	};
};

const insertGoodreads = (
	db: PostgresJsDatabase,
	batch: NewGoodreads[],
	resume: boolean,
) => {
	const values = batch.map((b) => ({
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
	}));

	if (resume) {
		return db.insert(goodreads).values(values).onConflictDoNothing();
	}

	return db
		.insert(goodreads)
		.values(values)
		.onConflictDoUpdate({
			target: goodreads.source_id,
			set: {
				title: sql.raw('excluded.title'),
				author: sql.raw('excluded.author'),
				rating: sql.raw('excluded.rating'),
				ratings_count: sql.raw('excluded.ratings_count'),
				description: sql.raw('excluded.description'),
				genres: sql.raw('excluded.genres'),
				isbn: sql.raw('excluded.isbn'),
				pages: sql.raw('excluded.pages'),
				year: sql.raw('excluded.year'),
				updated_at: sql.raw('now()'),
			},
			where: sql`
				goodreads.title IS DISTINCT FROM excluded.title
				OR goodreads.author IS DISTINCT FROM excluded.author
				OR goodreads.rating IS DISTINCT FROM excluded.rating
				OR goodreads.ratings_count IS DISTINCT FROM excluded.ratings_count
				OR goodreads.description IS DISTINCT FROM excluded.description
				OR goodreads.genres IS DISTINCT FROM excluded.genres
				OR goodreads.isbn IS DISTINCT FROM excluded.isbn
				OR goodreads.pages IS DISTINCT FROM excluded.pages
				OR goodreads.year IS DISTINCT FROM excluded.year
			`,
		});
};

const log = createLog('import-goodreads');

export const runImportGoodreads = async (
	dataDir: string,
	db: PostgresJsDatabase,
	opts?: { limit?: number; resume?: boolean },
) =>
	streamImport(dataDir, {
		filePattern: 'goodreads_records',
		log,
		parse: parseGoodreads,
		insert: (batch, resume) => insertGoodreads(db, batch, resume),
		resume: opts?.resume,
		limit: opts?.limit,
	});
