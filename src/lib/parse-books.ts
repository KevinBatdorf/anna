import type { Book } from '../db/schema';

type NewBook = Omit<Book, 'id'>;

export function parseBook(line: string): NewBook | null {
	try {
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
	} catch {
		return null;
	}
}
