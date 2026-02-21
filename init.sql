CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS books (
	id SERIAL PRIMARY KEY,
	source TEXT NOT NULL,
	source_id TEXT,
	title TEXT,
	author TEXT,
	publisher TEXT,
	language TEXT,
	year TEXT,
	extension TEXT,
	filesize INTEGER,
	pages TEXT,
	description TEXT,
	md5 TEXT,
	isbn TEXT,
	series TEXT,
	edition TEXT,
	search TSVECTOR GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
		setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
		setweight(to_tsvector('english', coalesce(publisher, '')), 'C') ||
		setweight(to_tsvector('english', coalesce(description, '')), 'D') ||
		to_tsvector('english', coalesce(isbn, ''))
	) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_source_id ON books(source_id);
CREATE INDEX IF NOT EXISTS idx_books_md5 ON books(md5);
CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_language ON books(language);
CREATE INDEX IF NOT EXISTS idx_books_extension ON books(extension);
CREATE INDEX IF NOT EXISTS idx_books_search ON books USING gin(search);

CREATE TABLE IF NOT EXISTS goodreads (
	id SERIAL PRIMARY KEY,
	source_id TEXT,
	title TEXT,
	author TEXT,
	rating REAL,
	ratings_count INTEGER,
	description TEXT,
	genres TEXT,
	isbn TEXT,
	pages TEXT,
	year TEXT,
	embedding vector(768),
	search TSVECTOR GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
		setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
		setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
		setweight(to_tsvector('english', coalesce(genres, '')), 'D') ||
		to_tsvector('english', coalesce(isbn, ''))
	) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodreads_source_id ON goodreads(source_id);
CREATE INDEX IF NOT EXISTS idx_goodreads_isbn ON goodreads(isbn);
CREATE INDEX IF NOT EXISTS idx_goodreads_search ON goodreads USING gin(search);

CREATE TABLE IF NOT EXISTS import_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);
