import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from '../src/lib/sanitize-fts';

describe('sanitizeFtsQuery', () => {
	it('wraps single word in quotes', () => {
		expect(sanitizeFtsQuery('dune')).toBe('"dune"');
	});

	it('wraps multiple words individually', () => {
		expect(sanitizeFtsQuery('frank herbert')).toBe('"frank" "herbert"');
	});

	it('strips single quotes', () => {
		expect(sanitizeFtsQuery("it's")).toBe('"its"');
	});

	it('strips double quotes', () => {
		expect(sanitizeFtsQuery('"hello"')).toBe('"hello"');
	});

	it('handles extra whitespace', () => {
		expect(sanitizeFtsQuery('  lots   of   space  ')).toBe(
			'"lots" "of" "space"',
		);
	});

	it('returns empty string for empty input', () => {
		expect(sanitizeFtsQuery('')).toBe('');
	});

	it('returns empty string for whitespace-only input', () => {
		expect(sanitizeFtsQuery('   ')).toBe('');
	});

	it('returns empty string for quotes-only input', () => {
		expect(sanitizeFtsQuery(`"'`)).toBe('');
	});

	it('handles mixed special chars and words', () => {
		expect(sanitizeFtsQuery('cat\'s "cradle"')).toBe('"cats" "cradle"');
	});
});
