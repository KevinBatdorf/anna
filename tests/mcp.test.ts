import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { downloadRoutes } from '../src/routes/download';
import { lookupRoutes } from '../src/routes/lookup';
import { mcpRoutes } from '../src/routes/mcp';
import { searchRoutes } from '../src/routes/search';
import { similarRoutes } from '../src/routes/similar';
import { statsRoutes } from '../src/routes/stats';

const TEST_DB_URL =
	process.env.DATABASE_URL || 'postgres://anna:anna@localhost:5432/anna';
const TEST_SCHEMA = `test_mcp_${Date.now()}`;

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

	// Seed data
	await sql`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
		VALUES ('zlib3', '123', 'The Hobbit', 'J.R.R. Tolkien', 'Allen & Unwin', 'en', '1937', 'epub', 500000, '310', 'A fantasy novel', 'abc123md5', '9780261103344', 'Middle-earth', '1st')`;

	await sql`INSERT INTO goodreads (source_id, title, author, rating, ratings_count, description, genres, isbn, pages, year)
		VALUES ('gr1', 'The Hobbit', 'J.R.R. Tolkien', 4.28, 3500000, 'Bilbo''s adventure', 'Fantasy,Adventure', '9780261103344', '310', '1937')`;

	await sql`INSERT INTO import_meta (key, value) VALUES ('books_count', '1')`;
	await sql`INSERT INTO import_meta (key, value) VALUES ('goodreads_count', '1')`;
	await sql`INSERT INTO import_meta (key, value) VALUES ('books_done', 'true')`;
	await sql`INSERT INTO import_meta (key, value) VALUES ('goodreads_done', 'true')`;

	const db = drizzle(sql, { schema });

	app = new Hono();
	app.route('/', searchRoutes(db, sql));
	app.route('/', similarRoutes(db, sql));
	app.route('/', lookupRoutes(db));
	app.route('/', statsRoutes(sql));
	app.route('/', downloadRoutes());
	mcpRoutes(app);
	app.notFound((c) => c.json({ error: 'Not found' }, 404));
});

afterAll(async () => {
	await sql`DROP SCHEMA IF EXISTS ${sql(TEST_SCHEMA)} CASCADE`;
	await sql.end();
});

/** Send a JSON-RPC 2.0 request to POST /mcp */
async function rpc(method: string, params?: unknown, id = 1) {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
	});
	return { status: res.status, body: await res.json() };
}

describe('GET /mcp', () => {
	it('returns tool listing', async () => {
		const res = await app.request('/mcp');
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.name).toBe('anna-archive');
		expect(body.tools).toContain('search_books');
		expect(body.tools).toContain('get_stats');
	});
});

describe('POST /mcp — tools/list', () => {
	it('lists all registered tools', async () => {
		const { status, body } = await rpc('tools/list');
		expect(status).toBe(200);
		const tools = body.result.tools;
		const names = tools.map((t: { name: string }) => t.name);
		expect(names).toContain('search_books');
		expect(names).toContain('search_goodreads');
		expect(names).toContain('find_similar');
		expect(names).toContain('lookup_isbn');
		expect(names).toContain('lookup_md5');
		expect(names).toContain('get_stats');
		expect(names).toContain('get_download_url');
	});
});

describe('POST /mcp — tools/call', () => {
	it('search_books returns results', async () => {
		const { body } = await rpc('tools/call', {
			name: 'search_books',
			arguments: { query: 'hobbit' },
		});
		const data = JSON.parse(body.result.content[0].text);
		expect(data.count).toBeGreaterThanOrEqual(1);
		expect(data.results[0].title).toBe('The Hobbit');
	});

	it('search_goodreads returns results', async () => {
		const { body } = await rpc('tools/call', {
			name: 'search_goodreads',
			arguments: { query: 'hobbit' },
		});
		const data = JSON.parse(body.result.content[0].text);
		expect(data.count).toBeGreaterThanOrEqual(1);
		expect(data.results[0].author).toBe('J.R.R. Tolkien');
	});

	it('lookup_isbn returns book and goodreads data', async () => {
		const { body } = await rpc('tools/call', {
			name: 'lookup_isbn',
			arguments: { isbn: '9780261103344' },
		});
		const data = JSON.parse(body.result.content[0].text);
		expect(data.book).not.toBeNull();
		expect(data.book.title).toBe('The Hobbit');
		expect(data.goodreads).not.toBeNull();
		expect(data.goodreads.rating).toBe(4.28);
	});

	it('lookup_md5 returns book data', async () => {
		const { body } = await rpc('tools/call', {
			name: 'lookup_md5',
			arguments: { md5: 'abc123md5' },
		});
		const data = JSON.parse(body.result.content[0].text);
		expect(data.title).toBe('The Hobbit');
	});

	it('get_stats returns counts', async () => {
		const { body } = await rpc('tools/call', {
			name: 'get_stats',
			arguments: {},
		});
		const data = JSON.parse(body.result.content[0].text);
		expect(data.books).toEqual({ count: 1, status: 'done' });
		expect(data.goodreads).toEqual({ count: 1, status: 'done' });
	});

	it('get_download_url returns error when API key not configured', async () => {
		const { body } = await rpc('tools/call', {
			name: 'get_download_url',
			arguments: { md5: 'abc123md5' },
		});
		const data = JSON.parse(body.result.content[0].text);
		// Without ANNAS_API_KEY set, the download route returns an error
		expect(data.error).toBeDefined();
	});

	it.skipIf(!!process.env.OLLAMA_URL)(
		'find_similar returns 503 when vec search is unavailable',
		async () => {
			const { body } = await rpc('tools/call', {
				name: 'find_similar',
				arguments: { query: 'hobbit' },
			});
			const data = JSON.parse(body.result.content[0].text);
			expect(data.error).toContain('Vector search not available');
		},
	);
});

describe('POST /mcp — error handling', () => {
	it('returns error for unknown method', async () => {
		const { status, body } = await rpc('nonexistent/method');
		expect(status).toBe(400);
		expect(body.error).toBeDefined();
		expect(body.error.code).toBe(-32601);
	});

	it('returns error for missing method', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
		});
		expect(res.status).toBe(400);
	});
});
