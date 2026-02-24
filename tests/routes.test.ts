import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { lookupRoutes } from '../src/routes/lookup';
import { searchRoutes } from '../src/routes/search';
import { similarRoutes } from '../src/routes/similar';
import { statsRoutes } from '../src/routes/stats';

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

	// Seed books
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
		VALUES ('zlib3', '123', 'The Hobbit', 'J.R.R. Tolkien', 'Allen & Unwin', 'en', '1937', 'epub', 500000, '310', 'A fantasy novel', 'abc123md5', '9780261103344', 'Middle-earth', '1st')`;
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
		VALUES ('zlib3', '456', 'Dune', 'Frank Herbert', 'Chilton Books', 'en', '1965', 'pdf', 800000, '412', 'Science fiction epic', 'def456md5', '9780441172719', 'Dune', '1st')`;
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
		VALUES ('zlib3', '789', 'The Hobbit', 'J.R.R. Tolkien', 'Allen & Unwin', 'en', '1937', 'pdf', 600000, '310', 'A fantasy novel', 'ghi789md5', '9780261103344', 'Middle-earth', '2nd')`;

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
	app.get('/', (c) => c.json({ name: 'test' }));
	app.notFound((c) => c.json({ error: 'Not found' }, 404));
});

afterAll(async () => {
	await sql`DROP SCHEMA IF EXISTS ${sql(TEST_SCHEMA)} CASCADE`;
	await sql.end();
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

describe('404 handling', () => {
	it('returns 404 for unknown routes', async () => {
		const { status, body } = await get('/nonexistent');
		expect(status).toBe(404);
		expect(body.error).toBe('Not found');
	});
});
