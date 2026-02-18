import { describe, expect, it } from 'vitest';
import { parseGoodreads, xmlTag } from '../src/lib/parse-goodreads';

// Real sample from the actual torrent data
const SAMPLE_LINE = JSON.stringify({
	aacid:
		'aacid__goodreads_records__20240913T115838Z__3929483__4ohhdEPrWJBm2EqkZ88xVV',
	metadata: {
		id: 3929483,
		record: `<?xml version="1.0" encoding="UTF-8"?>
<GoodreadsResponse>
  <Request><authentication>true</authentication></Request>
  <book>
<id>3929483</id>
<title><![CDATA[Encyclopedia of World Travel]]></title>
<title_without_series>Encyclopedia of World Travel</title_without_series>
<isbn>038506120X</isbn>
<isbn13>9780385061209</isbn13>
<publication_year>1973</publication_year>
<publisher>Doubleday</publisher>
<language_code>eng</language_code>
<description><![CDATA[8vo, Blue boards, silver letters.]]></description>
<average_rating>4.00</average_rating>
<num_pages>619</num_pages>
<ratings_count>2</ratings_count>
<authors>
<author>
<id>585855</id>
<name>Nelson Doubleday</name>
<role>Editor</role>
</author>
<author>
<id>5307191</id>
<name>C. Earl Cooley</name>
<role>Editor</role>
</author>
</authors>
</book>
</GoodreadsResponse>`,
	},
});

describe('xmlTag', () => {
	it('extracts plain text content', () => {
		expect(xmlTag('<num_pages>619</num_pages>', 'num_pages')).toBe('619');
	});

	it('extracts CDATA content', () => {
		expect(xmlTag('<title><![CDATA[Hello World]]></title>', 'title')).toBe(
			'Hello World',
		);
	});

	it('returns empty string for missing tag', () => {
		expect(xmlTag('<foo>bar</foo>', 'baz')).toBe('');
	});

	it('trims whitespace', () => {
		expect(xmlTag('<tag>  spaced  </tag>', 'tag')).toBe('spaced');
	});

	it('handles multiline content', () => {
		const xml = '<description><![CDATA[Line one.\nLine two.]]></description>';
		expect(xmlTag(xml, 'description')).toBe('Line one.\nLine two.');
	});
});

describe('parseGoodreads', () => {
	it('parses a real goodreads XML record', () => {
		const row = parseGoodreads(SAMPLE_LINE);
		expect(row).not.toBeNull();
		expect(row?.[0]).toBe('3929483'); // source_id
		expect(row?.[1]).toBe('Encyclopedia of World Travel'); // title (from title_without_series)
		expect(row?.[2]).toBe('Nelson Doubleday'); // author (first)
		expect(row?.[3]).toBe(4.0); // rating
		expect(row?.[4]).toBe(2); // ratings_count
		expect(row?.[5]).toBe('8vo, Blue boards, silver letters.'); // description
		expect(row?.[6]).toBe(''); // genres (not in XML)
		expect(row?.[7]).toBe('9780385061209'); // isbn13 preferred
		expect(row?.[8]).toBe('619'); // pages
		expect(row?.[9]).toBe('1973'); // year
	});

	it('falls back to <title> when title_without_series is empty', () => {
		const line = JSON.stringify({
			metadata: {
				id: 1,
				record: `<book>
<title><![CDATA[Full Title With Series (#1)]]></title>
<title_without_series></title_without_series>
<average_rating>3.50</average_rating>
<ratings_count>10</ratings_count>
<authors><author><name>Author</name></author></authors>
</book>`,
			},
		});
		const row = parseGoodreads(line);
		expect(row).not.toBeNull();
		expect(row?.[1]).toBe('Full Title With Series (#1)');
	});

	it('falls back to isbn when isbn13 is missing', () => {
		const line = JSON.stringify({
			metadata: {
				id: 2,
				record: `<book>
<title>Test</title>
<isbn>038506120X</isbn>
<average_rating>0.00</average_rating>
<ratings_count>0</ratings_count>
<authors><author><name>A</name></author></authors>
</book>`,
			},
		});
		const row = parseGoodreads(line);
		expect(row).not.toBeNull();
		expect(row?.[7]).toBe('038506120X');
	});

	it('handles 0.00 rating as null', () => {
		const line = JSON.stringify({
			metadata: {
				id: 3,
				record: `<book>
<title>Unrated</title>
<average_rating>0.00</average_rating>
<ratings_count>0</ratings_count>
<authors><author><name>A</name></author></authors>
</book>`,
			},
		});
		const row = parseGoodreads(line);
		expect(row).not.toBeNull();
		expect(row?.[3]).toBeNull(); // parseFloat("0.00") || null => null
	});

	it('returns null for missing record field', () => {
		const line = JSON.stringify({ metadata: { id: 4 } });
		expect(parseGoodreads(line)).toBeNull();
	});

	it('returns null for empty record', () => {
		const line = JSON.stringify({ metadata: { id: 5, record: '' } });
		expect(parseGoodreads(line)).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(parseGoodreads('not json')).toBeNull();
	});

	it('handles missing author gracefully', () => {
		const line = JSON.stringify({
			metadata: {
				id: 6,
				record: `<book>
<title>No Author Book</title>
<average_rating>3.00</average_rating>
<ratings_count>5</ratings_count>
</book>`,
			},
		});
		const row = parseGoodreads(line);
		expect(row).not.toBeNull();
		expect(row?.[2]).toBe(''); // author
	});
});
