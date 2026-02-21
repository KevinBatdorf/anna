import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Book } from '../../src/db/schema';
import { books } from '../../src/db/schema';
import { clean, createLog, streamImport } from './stream';

type NewBook = Omit<Book, 'id' | 'search'>;

export const parseBook = (line: string): NewBook => {
	const obj = JSON.parse(line);
	const m = obj.metadata ?? obj;
	return {
		source: 'zlib3',
		source_id: String(m.zlibrary_id ?? m.z_library_id ?? ''),
		title: m.title ?? '',
		author: m.author ?? '',
		publisher: m.publisher ?? '',
		language: m.language ?? '',
		year: m.year ?? '',
		extension: m.extension ?? '',
		filesize: m.filesize_reported ?? m.filesize ?? 0,
		pages: m.pages ?? '',
		description: m.description ?? '',
		md5: m.md5_reported ?? m.md5 ?? '',
		isbn: Array.isArray(m.isbns) ? (m.isbns[0] ?? '') : (m.isbn ?? ''),
		series: m.series ?? '',
		edition: m.edition ?? '',
	};
};

const insertBooks = (db: PostgresJsDatabase, batch: NewBook[]) =>
	db
		.insert(books)
		.values(
			batch.map((b) => ({
				source: b.source,
				source_id: b.source_id,
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
			})),
		)
		.onConflictDoUpdate({
			target: books.source_id,
			set: {
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
			},
		});

const log = createLog('import-books');

export const runImportBooks = async (
	dataDir: string,
	db: PostgresJsDatabase,
	limit?: number,
) =>
	streamImport(dataDir, {
		filePattern: 'zlib3_records',
		log,
		parse: parseBook,
		insert: (batch) => insertBooks(db, batch),
		limit,
	});
