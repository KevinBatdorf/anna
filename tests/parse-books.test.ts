import { describe, expect, it } from 'vitest';
import { parseBook } from '../scripts/import/books';

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
		expect(row?.source).toBe('zlib3');
		expect(row?.source_id).toBe('22430000');
		expect(row?.title).toBe('Els nens de la senyora Zlatin');
		expect(row?.author).toBe('Maria Lluïsa Amorós');
		expect(row?.publisher).toBe('ePubLibre');
		expect(row?.language).toBe('catalan');
		expect(row?.year).toBe('2021');
		expect(row?.extension).toBe('epub');
		expect(row?.filesize).toBe(483359);
		expect(row?.pages).toBe('');
		expect(row?.description).toBe('França, 1943.');
		expect(row?.md5).toBe('21f19f95c4b969d06fe5860a98e29f0d');
		expect(row?.isbn).toBe('');
		expect(row?.series).toBe('');
		expect(row?.edition).toBe('');
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
		expect(row?.isbn).toBe('9780123456789');
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
		expect(row?.isbn).toBe('978OLD');
	});

	it('throws on invalid JSON', () => {
		expect(() => parseBook('not json')).toThrow();
	});

	it('throws on empty string', () => {
		expect(() => parseBook('')).toThrow();
	});

	it('returns null for records with no title', () => {
		const line = JSON.stringify({ metadata: { zlibrary_id: 99 } });
		expect(parseBook(line)).toBeNull();
	});
});
