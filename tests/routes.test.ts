import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { lookupRoutes } from '../src/routes/lookup';
import { recommendRoutes } from '../src/routes/recommend';
import { searchRoutes } from '../src/routes/search';
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
    title, author, publisher, description, isbn, content=books, content_rowid=id
  )`);
	sqlite.run(`CREATE TABLE goodreads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT, title TEXT, author TEXT, rating REAL,
    ratings_count INTEGER, description TEXT, genres TEXT,
    isbn TEXT, pages TEXT, year TEXT
  )`);
	sqlite.run(`CREATE VIRTUAL TABLE goodreads_fts USING fts5(
    title, author, description, genres, isbn, content=goodreads, content_rowid=id
  )`);
	sqlite.run(`CREATE TABLE import_meta (key TEXT PRIMARY KEY, value TEXT)`);

	// Seed books
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

	const book2 = insertBook.run(
		'zlib3',
		'456',
		'Dune',
		'Frank Herbert',
		'Chilton Books',
		'en',
		'1965',
		'pdf',
		800000,
		'412',
		'Science fiction epic',
		'def456md5',
		'9780441172719',
		'Dune',
		'1st',
	);
	insertBookFts.run(
		book2.lastInsertRowid,
		'Dune',
		'Frank Herbert',
		'Chilton Books',
		'Science fiction epic',
		'9780441172719',
	);

	// Seed goodreads
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

	const gr2 = insertGr.run(
		'gr2',
		'Obscure Book',
		'Unknown Author',
		2.1,
		5,
		'Not very good',
		'Fiction',
		'',
		'100',
		'2020',
	);
	insertGrFts.run(
		gr2.lastInsertRowid,
		'Obscure Book',
		'Unknown Author',
		'Not very good',
		'Fiction',
		'',
	);

	// Seed import_meta
	sqlite.run(
		`INSERT INTO import_meta (key, value) VALUES ('zlib3_count', '2')`,
	);
	sqlite.run(
		`INSERT INTO import_meta (key, value) VALUES ('goodreads_count', '2')`,
	);

	const db = drizzle(sqlite, { schema });

	const app = new Hono();
	app.route('/', searchRoutes(db));
	app.route('/', recommendRoutes(db));
	app.route('/', lookupRoutes(db));
	app.route('/', statsRoutes(db));
	app.get('/', (c) => c.json({ name: 'test' }));
	app.notFound((c) => c.json({ error: 'Not found' }, 404));

	return app;
}

let app: Hono;
beforeAll(() => {
	app = createTestApp();
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
		expect(body.count).toBe(1);
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
		const { status, body } = await get('/search?q=*&limit=1');
		expect(status).toBe(200);
		expect(body.results.length).toBeLessThanOrEqual(1);
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

	it('returns 400 without q param', async () => {
		const { status } = await get('/search/goodreads');
		expect(status).toBe(400);
	});
});

describe('GET /recommend', () => {
	it('returns high-rated books', async () => {
		const { status, body } = await get('/recommend?q=hobbit');
		expect(status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.results[0].rating).toBeGreaterThanOrEqual(3.5);
		expect(body.results[0].ratings_count).toBeGreaterThanOrEqual(100);
	});

	it('filters out low-rated books', async () => {
		const { status, body } = await get('/recommend?q=obscure');
		expect(status).toBe(200);
		expect(body.count).toBe(0);
	});

	it('includes available book data when ISBN matches', async () => {
		const { status, body } = await get('/recommend?q=hobbit');
		expect(status).toBe(200);
		expect(body.results[0].available).not.toBeNull();
		expect(body.results[0].available.md5).toBe('abc123md5');
	});

	it('returns 400 without q param', async () => {
		const { status } = await get('/recommend');
		expect(status).toBe(400);
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
	it('returns counts and import metadata', async () => {
		const { status, body } = await get('/stats');
		expect(status).toBe(200);
		expect(body.books).toBe(2);
		expect(body.goodreads).toBe(2);
		expect(body.import.zlib3_count).toBe('2');
		expect(body.import.goodreads_count).toBe('2');
	});
});

describe('404 handling', () => {
	it('returns 404 for unknown routes', async () => {
		const { status, body } = await get('/nonexistent');
		expect(status).toBe(404);
		expect(body.error).toBe('Not found');
	});
});
