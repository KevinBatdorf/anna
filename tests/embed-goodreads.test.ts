import { describe, expect, it } from 'vitest';
import { composeEmbedText } from '../scripts/embed-goodreads';

describe('composeEmbedText', () => {
	it('joins title, author, description, genres', () => {
		const text = composeEmbedText({
			title: 'Dune',
			author: 'Frank Herbert',
			description: 'A desert planet epic',
			genres: 'Science Fiction, Adventure',
		});
		expect(text).toBe(
			'Dune | Frank Herbert | A desert planet epic | Science Fiction, Adventure',
		);
	});

	it('skips empty fields', () => {
		const text = composeEmbedText({
			title: 'Dune',
			author: 'Frank Herbert',
			description: '',
			genres: '',
		});
		expect(text).toBe('Dune | Frank Herbert');
	});

	it('truncates to 2048 chars', () => {
		const text = composeEmbedText({
			title: 'A'.repeat(3000),
			author: 'Author',
			description: 'Desc',
			genres: 'Genre',
		});
		expect(text.length).toBe(2048);
	});
});
