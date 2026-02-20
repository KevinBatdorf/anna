import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { lookupRoutes } from '../src/routes/lookup';
import { mcpRoutes } from '../src/routes/mcp';
import { searchRoutes } from '../src/routes/search';
import { similarRoutes } from '../src/routes/similar';
import { statsRoutes } from '../src/routes/stats';

function createTestApp() {
	const sqlite = new Database(':memory:');

	sqlite.run(`CREATE TABLE books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL, source_id TEXT, title TEXT, author TEXT,
    publisher TEXT, language TEXT, year TEXT, extension TEXT,
    filesize INTEGER, pages TEXT, description TEXT, md5 TEXT,
    isbn TEXT, series TEXT, edition TEXT
  )`);
	sqlite.run(`CREATE VIRTUAL TABLE books_fts USING fts5(
    title, author, publisher, description, isbn, content=books, content_rowid=id,
    tokenize='porter unicode61'
  )`);
	sqlite.run(`CREATE TABLE goodreads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT, title TEXT, author TEXT, rating REAL,
    ratings_count INTEGER, description TEXT, genres TEXT,
    isbn TEXT, pages TEXT, year TEXT
  )`);
	sqlite.run(`CREATE VIRTUAL TABLE goodreads_fts USING fts5(
    title, author, description, genres, isbn, content=goodreads, content_rowid=id,
    tokenize='porter unicode61'
  )`);
	sqlite.run(`CREATE TABLE import_meta (key TEXT PRIMARY KEY, value TEXT)`);

	const insertBook = sqlite.prepare(
		`INSERT INTO books (source, source_id, title, author, publisher, language, year, extension, filesize, pages, description, md5, isbn, series, edition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertBookFts = sqlite.prepare(
		`INSERT INTO books_fts (rowid, title, author, publisher, description, isbn) VALUES (?, ?, ?, ?, ?, ?)`,
	);

	const book1 = insertBook.run(
		'zlib3',
		'123',
		'The Hobbit',
		'J.R.R. Tolkien',
		'Allen & Unwin',
		'en',
		'1937',
		'epub',
		500000,
		'310',
		'A fantasy novel',
		'abc123md5',
		'9780261103344',
		'Middle-earth',
		'1st',
	);
	insertBookFts.run(
		book1.lastInsertRowid,
		'The Hobbit',
		'J.R.R. Tolkien',
		'Allen & Unwin',
		'A fantasy novel',
		'9780261103344',
	);

	const insertGr = sqlite.prepare(
		`INSERT INTO goodreads (source_id, title, author, rating, ratings_count, description, genres, isbn, pages, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertGrFts = sqlite.prepare(
		`INSERT INTO goodreads_fts (rowid, title, author, description, genres, isbn) VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const gr1 = insertGr.run(
		'gr1',
		'The Hobbit',
		'J.R.R. Tolkien',
		4.28,
		3500000,
		"Bilbo's adventure",
		'Fantasy,Adventure',
		'9780261103344',
		'310',
		'1937',
	);
	insertGrFts.run(
		gr1.lastInsertRowid,
		'The Hobbit',
		'J.R.R. Tolkien',
		"Bilbo's adventure",
		'Fantasy,Adventure',
		'9780261103344',
	);

	sqlite.run(
		`INSERT INTO import_meta (key, value) VALUES ('zlib3_count', '1')`,
	);
	sqlite.run(
		`INSERT INTO import_meta (key, value) VALUES ('goodreads_count', '1')`,
	);

	const db = drizzle(sqlite, { schema });

	const app = new Hono();
	app.route('/', searchRoutes(db, sqlite));
	app.route('/', similarRoutes(db, sqlite));
	app.route('/', lookupRoutes(db));
	app.route('/', statsRoutes(db));
	mcpRoutes(app);
	app.notFound((c) => c.json({ error: 'Not found' }, 404));

	return app;
}

let app: Hono;
beforeAll(() => {
	app = createTestApp();
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
		expect(data.books).toBe(1);
		expect(data.goodreads).toBe(1);
	});

	it('find_similar returns 503 when vec search is unavailable', async () => {
		const { body } = await rpc('tools/call', {
			name: 'find_similar',
			arguments: { query: 'hobbit' },
		});
		const data = JSON.parse(body.result.content[0].text);
		expect(data.error).toContain('Vector search not available');
	});
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
