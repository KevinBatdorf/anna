import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { lookupRoutes } from '../src/routes/lookup';
import { searchRoutes } from '../src/routes/search';
import { similarRoutes } from '../src/routes/similar';
import { statsRoutes } from '../src/routes/stats';

// Set BOOKS_DIR before importing library routes so the module picks it up
const TEST_BOOKS_DIR = join(tmpdir(), `anna-test-books-${Date.now()}`);
mkdirSync(TEST_BOOKS_DIR, { recursive: true });
process.env.BOOKS_DIR = TEST_BOOKS_DIR;

// Dynamic import after env is set
const { libraryRoutes } = await import('../src/routes/library');
const { readerRoutes } = await import('../src/routes/reader');

const TEST_DB_URL =
	process.env.DATABASE_URL || 'postgres://anna:anna@localhost:5432/anna';
const TEST_SCHEMA = `test_routes_${Date.now()}`;

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
	sql = postgres(TEST_DB_URL, { max: 1 });

	// Create isolated schema for this test run
	await sql`CREATE SCHEMA ${sql(TEST_SCHEMA)}`;
	await sql`CREATE EXTENSION IF NOT EXISTS vector`;
	await sql`SET search_path TO ${sql(TEST_SCHEMA)}, public`;

	// Create tables
	await sql`CREATE TABLE books (
		id SERIAL PRIMARY KEY,
		source TEXT NOT NULL, source_id TEXT UNIQUE, title TEXT, author TEXT,
		publisher TEXT, language TEXT, year TEXT, extension TEXT,
		filesize INTEGER, pages TEXT, description TEXT, md5 TEXT,
		isbn TEXT, series TEXT, edition TEXT,
		created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
		downloaded_at TIMESTAMPTZ,
		chapters JSONB,
		search tsvector GENERATED ALWAYS AS (
			setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
			setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
			setweight(to_tsvector('english', coalesce(publisher, '')), 'C') ||
			setweight(to_tsvector('english', coalesce(description, '')), 'D') ||
			to_tsvector('english', coalesce(isbn, ''))
		) STORED
	)`;
	await sql`CREATE INDEX ON books USING gin(search)`;

	await sql`CREATE TABLE goodreads (
		id SERIAL PRIMARY KEY,
		source_id TEXT UNIQUE, title TEXT, author TEXT, rating REAL,
		ratings_count INTEGER, description TEXT, genres TEXT,
		isbn TEXT, pages TEXT, year TEXT,
		embedding vector(768),
		created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
		search tsvector GENERATED ALWAYS AS (
			setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
			setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
			setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
			setweight(to_tsvector('english', coalesce(genres, '')), 'D') ||
			to_tsvector('english', coalesce(isbn, ''))
		) STORED
	)`;
	await sql`CREATE INDEX ON goodreads USING gin(search)`;

	await sql`CREATE TABLE import_meta (key TEXT PRIMARY KEY, value TEXT)`;

	await sql`CREATE TABLE book_pages (
		id SERIAL PRIMARY KEY,
		md5 TEXT NOT NULL,
		page_number INTEGER NOT NULL,
		content TEXT NOT NULL,
		embedding vector(768),
		created_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(md5, page_number)
	)`;

	// Seed books
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition, downloaded_at)
		VALUES ('zlib3', '123', 'The Hobbit', 'J.R.R. Tolkien', 'Allen & Unwin', 'en', '1937', 'epub', 500000, '310', 'A fantasy novel', 'abc123md5', '9780261103344', 'Middle-earth', '1st', now())`;
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
		VALUES ('zlib3', '456', 'Dune', 'Frank Herbert', 'Chilton Books', 'en', '1965', 'pdf', 800000, '412', 'Science fiction epic', 'def456md5', '9780441172719', 'Dune', '1st')`;
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
		VALUES ('zlib3', '789', 'The Hobbit', 'J.R.R. Tolkien', 'Allen & Unwin', 'en', '1937', 'pdf', 600000, '310', 'A fantasy novel', 'ghi789md5', '9780261103344', 'Middle-earth', '2nd')`;

	// Create a test file for the downloaded book
	writeFileSync(join(TEST_BOOKS_DIR, 'abc123md5.epub'), 'fake epub content');

	// Seed goodreads
	await sql`INSERT INTO goodreads (source_id, title, author, rating, ratings_count, description, genres, isbn, pages, year)
		VALUES ('gr1', 'The Hobbit', 'J.R.R. Tolkien', 4.28, 3500000, 'Bilbo''s adventure', 'Fantasy,Adventure', '9780261103344', '310', '1937')`;
	await sql`INSERT INTO goodreads (source_id, title, author, rating, ratings_count, description, genres, isbn, pages, year)
		VALUES ('gr2', 'Obscure Book', 'Unknown Author', 2.1, 5, 'Not very good', 'Fiction', '', '100', '2020')`;

	// Seed import_meta
	await sql`INSERT INTO import_meta (key, value) VALUES ('books_count', '3')`;
	await sql`INSERT INTO import_meta (key, value) VALUES ('goodreads_count', '2')`;
	await sql`INSERT INTO import_meta (key, value) VALUES ('books_done', 'true')`;
	await sql`INSERT INTO import_meta (key, value) VALUES ('goodreads_done', 'true')`;

	// Create a scoped sql that always uses our test schema
	const db = drizzle(sql, { schema });

	app = new Hono();
	app.route('/', searchRoutes(db, sql));
	app.route('/', similarRoutes(db, sql));
	app.route('/', lookupRoutes(db));
	app.route('/', statsRoutes(sql));
	app.route('/', libraryRoutes(db, sql));
	app.route('/', readerRoutes(db, sql));
	app.get('/', (c) => c.json({ name: 'test' }));
	app.notFound((c) => c.json({ error: 'Not found' }, 404));
});

afterAll(async () => {
	await sql`DROP SCHEMA IF EXISTS ${sql(TEST_SCHEMA)} CASCADE`;
	await sql.end();
	rmSync(TEST_BOOKS_DIR, { recursive: true, force: true });
});

async function get(path: string) {
	const res = await app.request(path);
	return { status: res.status, body: await res.json() };
}

describe('GET /', () => {
	it('returns API info', async () => {
		const { status, body } = await get('/');
		expect(status).toBe(200);
		expect(body.name).toBe('test');
	});
});

describe('GET /search', () => {
	it('searches books by title', async () => {
		const { status, body } = await get('/search?q=hobbit');
		expect(status).toBe(200);
		expect(body.count).toBeGreaterThanOrEqual(1);
		expect(body.results[0].title).toBe('The Hobbit');
	});

	it('searches books by author', async () => {
		const { status, body } = await get('/search?q=herbert');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('Dune');
	});

	it('returns 400 without q param', async () => {
		const { status, body } = await get('/search');
		expect(status).toBe(400);
		expect(body.error).toBeDefined();
	});

	it('respects limit', async () => {
		const { status, body } = await get('/search?q=hobbit&limit=1');
		expect(status).toBe(200);
		expect(body.results.length).toBeLessThanOrEqual(1);
	});

	it('filters by extension', async () => {
		const { status, body } = await get('/search?q=dune&ext=pdf');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.ext).toBe('pdf');
		expect(body.results[0].extension).toBe('pdf');
	});

	it('returns empty when extension does not match', async () => {
		const { status, body } = await get('/search?q=dune&ext=epub');
		expect(status).toBe(200);
		expect(body.count).toBe(0);
	});

	it('deduplicates by title+author keeping best format (pdf)', async () => {
		const { status, body } = await get('/search?q=hobbit');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].extension).toBe('pdf');
	});

	it('returns all formats when dedupe=false', async () => {
		const { status, body } = await get('/search?q=hobbit&dedupe=false');
		expect(status).toBe(200);
		expect(body.count).toBe(2);
	});

	it('filters by publisher', async () => {
		const { status, body } = await get('/search?publisher=Allen&dedupe=false');
		expect(status).toBe(200);
		expect(body.count).toBe(2);
		for (const r of body.results) {
			expect((r.publisher as string).toLowerCase()).toContain('allen');
		}
	});

	it('filters by author', async () => {
		const { status, body } = await get('/search?author=Herbert');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('Dune');
	});

	it('combines q with publisher filter', async () => {
		const { status, body } = await get(
			'/search?q=hobbit&publisher=Allen&dedupe=false',
		);
		expect(status).toBe(200);
		expect(body.count).toBe(2);
		expect(body.results[0].title).toBe('The Hobbit');
	});

	it('filters by language', async () => {
		const { status, body } = await get('/search?language=en&dedupe=false');
		expect(status).toBe(200);
		expect(body.count).toBe(3);
	});

	it('filters by year', async () => {
		const { status, body } = await get('/search?year=1965');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('Dune');
	});

	it('allows filters without q', async () => {
		const { status, body } = await get('/search?publisher=Chilton');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('Dune');
		expect(body.query).toBeUndefined();
	});

	it('returns 400 with no q and no filters', async () => {
		const { status, body } = await get('/search');
		expect(status).toBe(400);
		expect(body.error).toBeDefined();
	});
});

describe('GET /search/books', () => {
	it('is an alias for /search', async () => {
		const { status, body } = await get('/search/books?q=hobbit');
		expect(status).toBe(200);
		expect(body.results[0].title).toBe('The Hobbit');
	});
});

describe('GET /search/goodreads', () => {
	it('searches goodreads by title', async () => {
		const { status, body } = await get('/search/goodreads?q=hobbit');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].author).toBe('J.R.R. Tolkien');
	});

	it('returns 400 with no q and no filters', async () => {
		const { status } = await get('/search/goodreads');
		expect(status).toBe(400);
	});

	it('filters by author', async () => {
		const { status, body } = await get('/search/goodreads?author=Tolkien');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('The Hobbit');
	});

	it('filters by year', async () => {
		const { status, body } = await get('/search/goodreads?year=2020');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('Obscure Book');
	});

	it('filters by genre', async () => {
		const { status, body } = await get('/search/goodreads?genre=Fantasy');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('The Hobbit');
	});

	it('combines q with author filter', async () => {
		const { status, body } = await get(
			'/search/goodreads?q=adventure&author=Tolkien',
		);
		expect(status).toBe(200);
		expect(body.count).toBe(1);
	});
});

describe('GET /lookup/md5', () => {
	it('finds a book by md5', async () => {
		const { status, body } = await get('/lookup/md5?md5=abc123md5');
		expect(status).toBe(200);
		expect(body.title).toBe('The Hobbit');
	});

	it('returns 404 for unknown md5', async () => {
		const { status } = await get('/lookup/md5?md5=nonexistent');
		expect(status).toBe(404);
	});

	it('returns 400 without md5 param', async () => {
		const { status } = await get('/lookup/md5');
		expect(status).toBe(400);
	});
});

describe('GET /lookup/isbn', () => {
	it('returns both book and goodreads data', async () => {
		const { status, body } = await get('/lookup/isbn?isbn=9780261103344');
		expect(status).toBe(200);
		expect(body.book).not.toBeNull();
		expect(body.book.title).toBe('The Hobbit');
		expect(body.goodreads).not.toBeNull();
		expect(body.goodreads.rating).toBe(4.28);
	});

	it('returns nulls for unknown isbn', async () => {
		const { status, body } = await get('/lookup/isbn?isbn=0000000000000');
		expect(status).toBe(200);
		expect(body.book).toBeNull();
		expect(body.goodreads).toBeNull();
	});

	it('returns 400 without isbn param', async () => {
		const { status } = await get('/lookup/isbn');
		expect(status).toBe(400);
	});
});

describe('GET /stats', () => {
	it('returns structured stats', async () => {
		const { status, body } = await get('/stats');
		expect(status).toBe(200);
		expect(body.books).toEqual({ count: 3, status: 'done' });
		expect(body.goodreads).toEqual({ count: 2, status: 'done' });
		expect(body.embeddings.count).toBe(0);
		expect(body.embeddings.total).toBe(2);
		expect(body.embeddings.percent).toBe(0);
		expect(body.import).toBeDefined();
	});
});

describe('GET /similar', () => {
	it('returns 400 without q param', async () => {
		const { status, body } = await get('/similar');
		expect(status).toBe(400);
		expect(body.error).toBeDefined();
	});

	it.skipIf(!!process.env.OLLAMA_URL)(
		'returns 503 when vec search is not available',
		async () => {
			const { status, body } = await get('/similar?q=hobbit');
			expect(status).toBe(503);
			expect(body.error).toContain('Vector search not available');
		},
	);
});

describe('GET /library', () => {
	it('lists downloaded books', async () => {
		const { status, body } = await get('/library');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.total).toBe(1);
		expect(body.results[0].title).toBe('The Hobbit');
		expect(body.results[0].downloaded_at).toBeDefined();
	});

	it('respects limit and offset', async () => {
		const { status, body } = await get('/library?limit=1&offset=1');
		expect(status).toBe(200);
		expect(body.count).toBe(0);
	});
});

describe('GET /library/search', () => {
	it('searches within downloaded books', async () => {
		const { status, body } = await get('/library/search?q=hobbit');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].title).toBe('The Hobbit');
	});

	it('does not return non-downloaded books', async () => {
		const { status, body } = await get('/library/search?q=dune');
		expect(status).toBe(200);
		expect(body.count).toBe(0);
	});

	it('returns 400 without q or filters', async () => {
		const { status, body } = await get('/library/search');
		expect(status).toBe(400);
		expect(body.error).toBeDefined();
	});

	it('filters by author within library', async () => {
		const { status, body } = await get('/library/search?author=Tolkien');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
	});
});

describe('GET /library/:md5/file', () => {
	it('serves a downloaded file', async () => {
		const res = await app.request('/library/abc123md5/file');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/epub+zip');
		expect(res.headers.get('content-disposition')).toContain('The Hobbit');
		const text = await res.text();
		expect(text).toBe('fake epub content');
	});

	it('returns 404 for non-downloaded book', async () => {
		const { status, body } = await get('/library/def456md5/file');
		expect(status).toBe(404);
		expect(body.error).toBeDefined();
	});

	it('returns 404 for unknown md5', async () => {
		const { status, body } = await get('/library/nonexistent/file');
		expect(status).toBe(404);
		expect(body.error).toBeDefined();
	});
});

describe('POST /library/download', () => {
	it('returns 400 without md5 param', async () => {
		const res = await app.request('/library/download', { method: 'POST' });
		expect(res.status).toBe(400);
	});

	it('returns 404 for unknown md5', async () => {
		const res = await app.request('/library/download?md5=nonexistent', {
			method: 'POST',
		});
		expect(res.status).toBe(404);
	});

	it('returns error without ANNAS_API_KEY or when download fails', async () => {
		const res = await app.request('/library/download?md5=def456md5', {
			method: 'POST',
		});
		// 503 if no API key configured, 502 if key is set but download fails
		expect([502, 503]).toContain(res.status);
	});
});

describe('DELETE /library/:md5', () => {
	it('removes a downloaded book', async () => {
		// Seed a second downloaded book for deletion test
		await sql`INSERT INTO books (source, source_id, title, author, extension, md5, downloaded_at)
			VALUES ('zlib3', 'del1', 'Delete Me', 'Test Author', 'pdf', 'deleteme123', now())`;
		writeFileSync(join(TEST_BOOKS_DIR, 'deleteme123.pdf'), 'delete me');

		const res = await app.request('/library/deleteme123', {
			method: 'DELETE',
		});
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.ok).toBe(true);

		// Verify file is gone
		expect(existsSync(join(TEST_BOOKS_DIR, 'deleteme123.pdf'))).toBe(false);

		// Verify DB cleared
		const { body: listBody } = await get('/library/search?q=delete');
		expect(listBody.count).toBe(0);
	});

	it('returns 404 for non-downloaded book', async () => {
		const res = await app.request('/library/def456md5', {
			method: 'DELETE',
		});
		expect(res.status).toBe(404);
	});

	it('returns 404 for unknown md5', async () => {
		const res = await app.request('/library/nonexistent', {
			method: 'DELETE',
		});
		expect(res.status).toBe(404);
	});
});

// Check if poppler-utils (pdfinfo + pdftotext) are available for reader tests
let hasPdfTools = false;
try {
	const p1 = Bun.spawnSync(['pdfinfo', '-v'], { stderr: 'pipe' });
	const p2 = Bun.spawnSync(['pdftotext', '-v'], { stderr: 'pipe' });
	hasPdfTools =
		(p1.exitCode === 0 || p1.exitCode === 99) &&
		(p2.exitCode === 0 || p2.exitCode === 99);
} catch {}

describe('GET /reader/:md5/status', () => {
	it('returns status for a known book with no pages', async () => {
		const { status, body } = await get('/reader/abc123md5/status');
		expect(status).toBe(200);
		expect(body.md5).toBe('abc123md5');
		expect(body.title).toBe('The Hobbit');
		expect(body.downloaded).toBe(true);
		expect(body.indexed).toBe(false);
		expect(body.pages_extracted).toBe(0);
		expect(body.pages_embedded).toBe(0);
		expect(body.ready_for_search).toBe(false);
		expect(body.chapters).toEqual([]);
	});

	it('returns chapters when stored', async () => {
		const chapters = [
			{ title: 'Chapter 1', page: 1 },
			{
				title: 'Chapter 2',
				page: 10,
				children: [{ title: 'Section 2.1', page: 12 }],
			},
		];
		await sql`UPDATE books SET chapters = ${JSON.stringify(chapters)}::jsonb WHERE md5 = 'abc123md5'`;
		const { status, body } = await get('/reader/abc123md5/status');
		expect(status).toBe(200);
		expect(body.chapters).toEqual(chapters);
		// Clean up
		await sql`UPDATE books SET chapters = NULL WHERE md5 = 'abc123md5'`;
	});

	it('returns status with extracted pages', async () => {
		await sql`INSERT INTO book_pages (md5, page_number, content)
			VALUES ('abc123md5', 1, 'Page one text'), ('abc123md5', 2, 'Page two text')`;
		const { status, body } = await get('/reader/abc123md5/status');
		expect(status).toBe(200);
		expect(body.indexed).toBe(true);
		expect(body.pages_extracted).toBe(2);
		expect(body.pages_embedded).toBe(0);
		expect(body.ready_for_search).toBe(false);
		// Clean up
		await sql`DELETE FROM book_pages WHERE md5 = 'abc123md5'`;
	});

	it('returns 404 for unknown md5', async () => {
		const { status, body } = await get('/reader/nonexistent/status');
		expect(status).toBe(404);
		expect(body.error).toBeDefined();
	});

	it('shows non-downloaded book correctly', async () => {
		const { status, body } = await get('/reader/def456md5/status');
		expect(status).toBe(200);
		expect(body.downloaded).toBe(false);
		expect(body.extension).toBe('pdf');
	});
});

describe('GET /reader/:md5/page/:page', () => {
	it('returns page text for a seeded page', async () => {
		await sql`DELETE FROM book_pages WHERE md5 = 'abc123md5'`;
		await sql`INSERT INTO book_pages (md5, page_number, content)
			VALUES ('abc123md5', 1, 'Chapter 1: An Unexpected Party')`;
		const { status, body } = await get('/reader/abc123md5/page/1');
		expect(status).toBe(200);
		expect(body.md5).toBe('abc123md5');
		expect(body.page).toBe(1);
		expect(body.content).toBe('Chapter 1: An Unexpected Party');
		await sql`DELETE FROM book_pages WHERE md5 = 'abc123md5'`;
	});

	it('returns 404 for non-existent page', async () => {
		const { status, body } = await get('/reader/abc123md5/page/999');
		expect(status).toBe(404);
		expect(body.error).toBeDefined();
	});

	it('returns 400 for invalid page number', async () => {
		const { status, body } = await get('/reader/abc123md5/page/0');
		expect(status).toBe(400);
		expect(body.error).toContain('Invalid');
	});
});

describe('POST /reader/:md5/index', () => {
	it('returns 404 for unknown md5', async () => {
		const res = await app.request('/reader/nonexistent/index', {
			method: 'POST',
		});
		expect(res.status).toBe(404);
	});

	it('returns 400 for non-downloaded book', async () => {
		const res = await app.request('/reader/def456md5/index', {
			method: 'POST',
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain('not downloaded');
	});

	it('returns 400 for non-PDF book', async () => {
		// abc123md5 is an epub
		const res = await app.request('/reader/abc123md5/index', {
			method: 'POST',
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain('PDF');
	});

	it.skipIf(!hasPdfTools)('indexes a real PDF and extracts pages', async () => {
		// Create a minimal PDF with 2 pages
		const pdfContent = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 100 700 Td (Page one text) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
6 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 7 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
7 0 obj<</Length 44>>stream
BT /F1 12 Tf 100 700 Td (Page two text) Tj ET
endstream
endobj
xref
0 8
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000360 00000 n
0000000441 00000 n
0000000592 00000 n
trailer<</Size 8/Root 1 0 R>>
startxref
686
%%EOF`;

		// Insert a test PDF book
		await sql`INSERT INTO books (source, source_id, title, author, extension, md5, downloaded_at)
				VALUES ('zlib3', 'pdf1', 'Test PDF', 'Test Author', 'pdf', 'testpdf123', now())
				ON CONFLICT (source_id) DO NOTHING`;

		writeFileSync(join(TEST_BOOKS_DIR, 'testpdf123.pdf'), pdfContent);

		const res = await app.request('/reader/testpdf123/index', {
			method: 'POST',
		});
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.pages).toBe(2);

		// Verify pages were stored
		const pages =
			await sql`SELECT page_number, content FROM book_pages WHERE md5 = 'testpdf123' ORDER BY page_number`;
		expect(pages.length).toBe(2);
		expect(pages[0].content).toContain('Page one text');
		expect(pages[1].content).toContain('Page two text');

		// Clean up
		await sql`DELETE FROM book_pages WHERE md5 = 'testpdf123'`;
		await sql`DELETE FROM books WHERE md5 = 'testpdf123'`;
	});
});

describe('GET /reader/:md5/page/:page/image', () => {
	it('returns 404 for unknown md5', async () => {
		const { status } = await get('/reader/nonexistent/page/1/image');
		expect(status).toBe(404);
	});

	it('returns 400 for non-downloaded book', async () => {
		const { status, body } = await get('/reader/def456md5/page/1/image');
		expect(status).toBe(400);
		expect(body.error).toContain('not downloaded');
	});

	it('returns 400 for non-PDF book', async () => {
		const { status, body } = await get('/reader/abc123md5/page/1/image');
		expect(status).toBe(400);
		expect(body.error).toContain('PDF');
	});

	it('returns 400 for invalid page number', async () => {
		const { status, body } = await get('/reader/abc123md5/page/0/image');
		expect(status).toBe(400);
		expect(body.error).toContain('Invalid');
	});
});

describe('GET /reader/:md5/search', () => {
	it('returns 400 without q param', async () => {
		const { status, body } = await get('/reader/abc123md5/search');
		expect(status).toBe(400);
		expect(body.error).toContain('Missing');
	});

	it.skipIf(!!process.env.OLLAMA_URL)(
		'returns 503 when Ollama not configured',
		async () => {
			const { status } = await get('/reader/abc123md5/search?q=test');
			expect(status).toBe(503);
		},
	);
});

describe('POST /reader/:md5/embed', () => {
	it('returns 400 for book with no pages', async () => {
		const res = await app.request('/reader/abc123md5/embed', {
			method: 'POST',
		});
		const body = await res.json();
		expect(res.status).toBe(400);
		expect(body.error).toContain('not indexed');
	});

	it.skipIf(!!process.env.OLLAMA_URL)(
		'returns 503 when Ollama not configured',
		async () => {
			// Seed a page so it's "indexed"
			await sql`INSERT INTO book_pages (md5, page_number, content)
				VALUES ('abc123md5', 1, 'Some text')`;
			const res = await app.request('/reader/abc123md5/embed', {
				method: 'POST',
			});
			expect(res.status).toBe(503);
			await sql`DELETE FROM book_pages WHERE md5 = 'abc123md5'`;
		},
	);
});

describe('404 handling', () => {
	it('returns 404 for unknown routes', async () => {
		const { status, body } = await get('/nonexistent');
		expect(status).toBe(404);
		expect(body.error).toBe('Not found');
	});
});
