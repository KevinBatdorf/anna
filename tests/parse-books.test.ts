import { describe, expect, it } from 'vitest';
import { parseBook } from '../src/lib/parse-books';

const SAMPLE_LINE = JSON.stringify({
	aacid:
		'aacid__zlib3_records__20240809T171652Z__22430000__gFm3K4DHqd6YyKbz4DfQ8W',
	metadata: {
		zlibrary_id: 22430000,
		date_added: '2022-08-24',
		date_modified: '2023-04-05',
		extension: 'epub',
		filesize_reported: 483359,
		md5_reported: '21f19f95c4b969d06fe5860a98e29f0d',
		title: 'Els nens de la senyora Zlatin',
		author: 'Maria Lluïsa Amorós',
		publisher: 'ePubLibre',
		language: 'catalan',
		series: '',
		volume: '',
		edition: '',
		year: '2021',
		pages: '',
		description: 'França, 1943.',
		cover_path: '/covers/books/21/f1/9f/21f19f95c4b969d06fe5860a98e29f0d.jpg',
		isbns: [],
		category_id: '',
	},
});

describe('parseBook', () => {
	it('parses a real zlib3 record', () => {
		const row = parseBook(SAMPLE_LINE);
		expect(row).not.toBeNull();
		expect(row?.[0]).toBe('zlib3');
		expect(row?.[1]).toBe('22430000'); // source_id
		expect(row?.[2]).toBe('Els nens de la senyora Zlatin'); // title
		expect(row?.[3]).toBe('Maria Lluïsa Amorós'); // author
		expect(row?.[4]).toBe('ePubLibre'); // publisher
		expect(row?.[5]).toBe('catalan'); // language
		expect(row?.[6]).toBe('2021'); // year
		expect(row?.[7]).toBe('epub'); // extension
		expect(row?.[8]).toBe(483359); // filesize
		expect(row?.[9]).toBe(''); // pages
		expect(row?.[10]).toBe('França, 1943.'); // description
		expect(row?.[11]).toBe('21f19f95c4b969d06fe5860a98e29f0d'); // md5
		expect(row?.[12]).toBe(''); // isbn (empty isbns array)
		expect(row?.[13]).toBe(''); // series
		expect(row?.[14]).toBe(''); // edition
	});

	it('extracts first isbn from isbns array', () => {
		const line = JSON.stringify({
			metadata: {
				zlibrary_id: 1,
				title: 'Test',
				author: '',
				publisher: '',
				language: 'eng',
				year: '',
				extension: 'pdf',
				filesize_reported: 100,
				pages: '',
				description: '',
				md5_reported: 'abc',
				isbns: ['9780123456789', '9780987654321'],
				series: '',
				edition: '',
			},
		});
		const row = parseBook(line);
		expect(row).not.toBeNull();
		expect(row?.[12]).toBe('9780123456789');
	});

	it('falls back to isbn field if isbns is not an array', () => {
		const line = JSON.stringify({
			metadata: {
				zlibrary_id: 2,
				title: 'Test',
				author: '',
				publisher: '',
				language: 'eng',
				year: '',
				extension: 'pdf',
				filesize_reported: 100,
				pages: '',
				description: '',
				md5_reported: 'abc',
				isbn: '978OLD',
				series: '',
				edition: '',
			},
		});
		const row = parseBook(line);
		expect(row).not.toBeNull();
		expect(row?.[12]).toBe('978OLD');
	});

	it('returns null for invalid JSON', () => {
		expect(parseBook('not json')).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(parseBook('')).toBeNull();
	});

	it('handles missing metadata fields gracefully', () => {
		const line = JSON.stringify({ metadata: { zlibrary_id: 99 } });
		const row = parseBook(line);
		expect(row).not.toBeNull();
		expect(row?.[0]).toBe('zlib3');
		expect(row?.[1]).toBe('99');
		expect(row?.[2]).toBe(''); // title defaults to ""
		expect(row?.[8]).toBe(0); // filesize defaults to 0
	});
});
