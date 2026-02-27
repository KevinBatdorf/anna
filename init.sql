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
	created_at TIMESTAMPTZ DEFAULT now(),
	updated_at TIMESTAMPTZ DEFAULT now(),
	search TSVECTOR GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
		setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
		setweight(to_tsvector('english', coalesce(publisher, '')), 'C') ||
		setweight(to_tsvector('english', coalesce(description, '')), 'D') ||
		to_tsvector('english', coalesce(isbn, ''))
	) STORED
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_source_id ON books(source_id);
CREATE INDEX IF NOT EXISTS idx_books_md5 ON books(md5);
CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_language ON books(language);
CREATE INDEX IF NOT EXISTS idx_books_extension ON books(extension);
CREATE INDEX IF NOT EXISTS idx_books_search ON books USING gin(search);
CREATE INDEX IF NOT EXISTS idx_books_publisher_trgm ON books USING gin(publisher gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_books_author_trgm ON books USING gin(author gin_trgm_ops);

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
	created_at TIMESTAMPTZ DEFAULT now(),
	updated_at TIMESTAMPTZ DEFAULT now(),
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

-- Add timestamp columns to existing tables (no-op on fresh DB)
ALTER TABLE books ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE books ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE books ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_books_downloaded ON books(downloaded_at) WHERE downloaded_at IS NOT NULL;
ALTER TABLE goodreads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE goodreads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS import_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);

CREATE TABLE IF NOT EXISTS book_pages (
	id SERIAL PRIMARY KEY,
	md5 TEXT NOT NULL,
	page_number INTEGER NOT NULL,
	content TEXT NOT NULL,
	embedding vector(768),
	created_at TIMESTAMPTZ DEFAULT now(),
	UNIQUE(md5, page_number)
);

CREATE INDEX IF NOT EXISTS idx_book_pages_md5 ON book_pages(md5);

-- Reader metadata: chapter outline extracted from PDF bookmarks
ALTER TABLE books ADD COLUMN IF NOT EXISTS chapters JSONB;
