import type { Goodreads } from '../db/schema';

type NewGoodreads = Omit<Goodreads, 'id'>;

export function xmlTag(xml: string, tag: string): string {
	const re = new RegExp(
		`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`,
		's',
	);
	const m = re.exec(xml);
	return m ? m[1].trim() : '';
}

export function parseGoodreads(line: string): NewGoodreads | null {
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
	} catch {
		return null;
	}
}
