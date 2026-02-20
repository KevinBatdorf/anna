import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from '../src/lib/sanitize-fts';

describe('sanitizeFtsQuery', () => {
	it('appends prefix wildcard to single word', () => {
		expect(sanitizeFtsQuery('dune')).toBe('dune*');
	});

	it('appends prefix wildcard to multiple words', () => {
		expect(sanitizeFtsQuery('frank herbert')).toBe('frank* herbert*');
	});

	it('strips single quotes', () => {
		expect(sanitizeFtsQuery("it's")).toBe('its*');
	});

	it('strips double quotes', () => {
		expect(sanitizeFtsQuery('"hello"')).toBe('hello*');
	});

	it('handles extra whitespace', () => {
		expect(sanitizeFtsQuery('  lots   of   space  ')).toBe('lots* of* space*');
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
		expect(sanitizeFtsQuery('cat\'s "cradle"')).toBe('cats* cradle*');
	});

	it('strips FTS5 operators', () => {
		expect(sanitizeFtsQuery('cats AND dogs')).toBe('cats* dogs*');
		expect(sanitizeFtsQuery('NOT bad OR good')).toBe('bad* good*');
		expect(sanitizeFtsQuery('NEAR cats')).toBe('cats*');
	});

	it('strips colons and special chars', () => {
		expect(sanitizeFtsQuery('title:dune')).toBe('titledune*');
	});

	it('strips leading hyphens', () => {
		expect(sanitizeFtsQuery('-excluded term')).toBe('excluded* term*');
		expect(sanitizeFtsQuery('--double')).toBe('double*');
	});

	it('strips asterisks from input', () => {
		expect(sanitizeFtsQuery('web*')).toBe('web*');
	});

	it('strips parentheses and braces', () => {
		expect(sanitizeFtsQuery('(test) {value}')).toBe('test* value*');
	});
});
