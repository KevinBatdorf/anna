import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type postgres from 'postgres';
import type * as schema from '../db/schema';
import { isOllamaEnabled } from '../lib/ollama';
import { embedBook, indexBook } from './reader';

type DB = PostgresJsDatabase<typeof schema>;

const ANNAS_BASE_URL = process.env.ANNAS_BASE_URL || 'https://annas-archive.pk';
const ANNAS_API_KEY = process.env.ANNAS_API_KEY || '';
export const BOOKS_DIR =
	process.env.BOOKS_DIR || resolve(import.meta.dir, '../../data/books');

const CONTENT_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	epub: 'application/epub+zip',
	mobi: 'application/x-mobipocket-ebook',
	djvu: 'image/vnd.djvu',
	txt: 'text/plain',
	cbz: 'application/x-cbz',
	cbr: 'application/x-cbr',
	azw3: 'application/x-mobi8-ebook',
	fb2: 'application/x-fictionbook+xml',
};

function sanitizeFilename(s: string): string {
	return s.replace(/[^a-zA-Z0-9_\- .()]/g, '').trim();
}

export function libraryRoutes(_db: DB, raw: postgres.Sql) {
	const app = new Hono();

	// GET /library — list downloaded books
	app.get('/library', async (c) => {
		const limit = Math.min(
			Number.parseInt(c.req.query('limit') || '20', 10),
			100,
		);
		const offset = Number.parseInt(c.req.query('offset') || '0', 10);

		try {
			const results = await raw`
				SELECT id, source, source_id, title, author, publisher,
				       language, year, extension, filesize, pages, md5, isbn, series,
				       downloaded_at
				FROM books
				WHERE downloaded_at IS NOT NULL
				ORDER BY downloaded_at DESC
				LIMIT ${limit}
				OFFSET ${offset}`;

			const countResult = await raw`
				SELECT count(*)::int AS total FROM books WHERE downloaded_at IS NOT NULL`;

			return c.json({
				count: results.length,
				total: countResult[0].total,
				offset,
				results,
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Failed to list library', detail: msg }, 500);
		}
	});

	// GET /library/search?q=... — FTS search within library
	app.get('/library/search', async (c) => {
		const q = c.req.query('q');
		const author = c.req.query('author');
		const publisher = c.req.query('publisher');
		const language = c.req.query('language');
		const year = c.req.query('year');
		const ext = c.req.query('ext');
		const hasFilters = author || publisher || language || year;

		if (!q && !hasFilters)
			return c.json(
				{
					error:
						'Provide ?q= and/or filter params (author, publisher, language, year)',
				},
				400,
			);

		const limit = Math.min(
			Number.parseInt(c.req.query('limit') || '20', 10),
			100,
		);
		const offset = Number.parseInt(c.req.query('offset') || '0', 10);

		const conditions = [raw`downloaded_at IS NOT NULL`];
		if (q) conditions.push(raw`search @@ plainto_tsquery('english', ${q})`);
		if (author) conditions.push(raw`author ILIKE ${`%${author}%`}`);
		if (publisher) conditions.push(raw`publisher ILIKE ${`%${publisher}%`}`);
		if (language) conditions.push(raw`language = ${language.toLowerCase()}`);
		if (year) conditions.push(raw`year = ${year}`);
		if (ext) conditions.push(raw`extension = ${ext.toLowerCase()}`);

		const where = conditions.reduce((acc, cond, i) =>
			i === 0 ? cond : raw`${acc} AND ${cond}`,
		);

		const orderBy = q
			? raw`ORDER BY ts_rank(search, plainto_tsquery('english', ${q})) DESC`
			: raw`ORDER BY downloaded_at DESC`;

		try {
			const results = await raw`
				SELECT id, source, source_id, title, author, publisher,
				       language, year, extension, filesize, pages, md5, isbn, series,
				       downloaded_at
				FROM books
				WHERE ${where}
				${orderBy}
				LIMIT ${limit}
				OFFSET ${offset}`;

			return c.json({
				...(q ? { query: q } : {}),
				...(author ? { author } : {}),
				...(publisher ? { publisher } : {}),
				...(language ? { language } : {}),
				...(year ? { year } : {}),
				...(ext ? { ext } : {}),
				count: results.length,
				offset,
				results,
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Search failed', detail: msg }, 500);
		}
	});

	// POST /library/download?md5=... — download a book to local storage
	app.post('/library/download', async (c) => {
		const md5 = c.req.query('md5');
		if (!md5) return c.json({ error: 'Missing ?md5= parameter' }, 400);
		if (!ANNAS_API_KEY) {
			return c.json(
				{
					error: 'ANNAS_API_KEY not configured',
					hint: 'Set ANNAS_API_KEY in your .env file.',
				},
				503,
			);
		}

		// Look up book in DB
		const rows = await raw`
			SELECT id, extension, downloaded_at, title, author
			FROM books WHERE md5 = ${md5} LIMIT 1`;
		if (rows.length === 0)
			return c.json({ error: 'Book not found in database' }, 404);

		const book = rows[0];
		const ext = (book.extension as string) || 'bin';
		const filePath = resolve(BOOKS_DIR, `${md5}.${ext}`);

		// Already downloaded?
		if (book.downloaded_at && existsSync(filePath)) {
			return c.json({ error: 'Already downloaded', md5, path: filePath }, 409);
		}

		// Get download URL from Anna's Archive
		let downloadUrl: string;
		try {
			const apiUrl = `${ANNAS_BASE_URL}/dyn/api/fast_download.json?md5=${encodeURIComponent(md5)}&key=${encodeURIComponent(ANNAS_API_KEY)}`;
			const res = await fetch(apiUrl, {
				signal: AbortSignal.timeout(30_000),
			});
			const data = await res.json();
			if (!res.ok || !data.download_url)
				return c.json(
					{ error: 'Failed to get download URL', detail: data },
					502,
				);
			downloadUrl = data.download_url;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Download URL request failed', detail: msg }, 502);
		}

		// Ensure books directory exists
		mkdirSync(BOOKS_DIR, { recursive: true });

		// Download file to tmp path, then rename
		const tmpPath = `${filePath}.tmp`;
		try {
			const res = await fetch(downloadUrl, {
				signal: AbortSignal.timeout(120_000),
			});
			if (!res.ok || !res.body)
				return c.json(
					{ error: 'File download failed', status: res.status },
					502,
				);

			await Bun.write(tmpPath, await res.arrayBuffer());
			await rename(tmpPath, filePath);
		} catch (e: unknown) {
			// Clean up tmp file on failure
			try {
				unlinkSync(tmpPath);
			} catch {}
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'File download failed', detail: msg }, 502);
		}

		// Mark as downloaded in DB
		await raw`UPDATE books SET downloaded_at = now() WHERE md5 = ${md5}`;

		const fileInfo = await stat(filePath);

		// Auto-index PDFs in the background (fire-and-forget)
		if (ext === 'pdf') {
			indexBook(md5, filePath, raw)
				.then(() => {
					if (isOllamaEnabled()) return embedBook(md5, raw);
				})
				.catch((e) => {
					console.error(`Auto-index failed for ${md5}:`, e);
				});
		}

		return c.json({
			ok: true,
			md5,
			title: book.title,
			author: book.author,
			extension: ext,
			size: fileInfo.size,
			path: filePath,
		});
	});

	// GET /library/:md5/file — serve the actual file
	app.get('/library/:md5/file', async (c) => {
		const md5 = c.req.param('md5');

		const rows = await raw`
			SELECT title, author, extension FROM books
			WHERE md5 = ${md5} AND downloaded_at IS NOT NULL
			LIMIT 1`;
		if (rows.length === 0)
			return c.json({ error: 'Book not found in library' }, 404);

		const book = rows[0];
		const ext = (book.extension as string) || 'bin';
		const filePath = resolve(BOOKS_DIR, `${md5}.${ext}`);

		if (!existsSync(filePath))
			return c.json({ error: 'File missing from disk' }, 404);

		const file = Bun.file(filePath);
		const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

		const title = sanitizeFilename((book.title as string) || md5);
		const author = sanitizeFilename((book.author as string) || '');
		const filename = author ? `${title} - ${author}.${ext}` : `${title}.${ext}`;

		return new Response(file.stream(), {
			headers: {
				'Content-Type': contentType,
				'Content-Disposition': `attachment; filename="${filename}"`,
				'Content-Length': String(file.size),
			},
		});
	});

	// DELETE /library/:md5 — remove a downloaded book
	app.delete('/library/:md5', async (c) => {
		const md5 = c.req.param('md5');

		const rows = await raw`
			SELECT extension, downloaded_at FROM books
			WHERE md5 = ${md5} LIMIT 1`;
		if (rows.length === 0) return c.json({ error: 'Book not found' }, 404);
		if (!rows[0].downloaded_at)
			return c.json({ error: 'Book not in library' }, 404);

		const ext = (rows[0].extension as string) || 'bin';
		const filePath = resolve(BOOKS_DIR, `${md5}.${ext}`);

		// Delete file (ignore if already missing)
		try {
			unlinkSync(filePath);
		} catch {}

		// Clear downloaded_at
		await raw`UPDATE books SET downloaded_at = NULL WHERE md5 = ${md5}`;

		return c.json({ ok: true, md5 });
	});

	return app;
}
