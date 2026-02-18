export type BookRow = [
	source: string,
	source_id: string,
	title: string,
	author: string,
	publisher: string,
	language: string,
	year: string,
	extension: string,
	filesize: number,
	pages: string,
	description: string,
	md5: string,
	isbn: string,
	series: string,
	edition: string,
];

export function parseBook(line: string): BookRow | null {
	try {
		const obj = JSON.parse(line);
		const m = obj.metadata ?? obj;
		return [
			'zlib3',
			String(m.zlibrary_id ?? m.z_library_id ?? ''),
			m.title ?? '',
			m.author ?? '',
			m.publisher ?? '',
			m.language ?? '',
			m.year ?? '',
			m.extension ?? '',
			m.filesize_reported ?? m.filesize ?? 0,
			m.pages ?? '',
			m.description ?? '',
			m.md5_reported ?? m.md5 ?? '',
			Array.isArray(m.isbns) ? (m.isbns[0] ?? '') : (m.isbn ?? ''),
			m.series ?? '',
			m.edition ?? '',
		];
	} catch {
		return null;
	}
}
