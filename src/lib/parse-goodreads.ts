export type GoodreadsRow = [
	source_id: string,
	title: string,
	author: string,
	rating: number | null,
	ratings_count: number,
	description: string,
	genres: string,
	isbn: string,
	pages: string,
	year: string,
];

export function xmlTag(xml: string, tag: string): string {
	const re = new RegExp(
		`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`,
		's',
	);
	const m = re.exec(xml);
	return m ? m[1].trim() : '';
}

export function parseGoodreads(line: string): GoodreadsRow | null {
	try {
		const obj = JSON.parse(line);
		const meta = obj.metadata;
		const xml: string = meta?.record ?? '';
		if (!xml) return null;

		const title = xmlTag(xml, 'title_without_series') || xmlTag(xml, 'title');
		const rating = parseFloat(xmlTag(xml, 'average_rating')) || null;
		const ratingsCount = parseInt(xmlTag(xml, 'ratings_count'), 10) || 0;

		const authorMatch =
			/<authors>[\s\S]*?<author>[\s\S]*?<name>(.*?)<\/name>/s.exec(xml);
		const author = authorMatch ? authorMatch[1].trim() : '';

		return [
			String(meta.id ?? ''),
			title,
			author,
			rating,
			ratingsCount,
			xmlTag(xml, 'description'),
			'',
			xmlTag(xml, 'isbn13') || xmlTag(xml, 'isbn'),
			xmlTag(xml, 'num_pages'),
			xmlTag(xml, 'publication_year'),
		];
	} catch {
		return null;
	}
}
