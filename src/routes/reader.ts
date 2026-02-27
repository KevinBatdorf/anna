import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type postgres from 'postgres';
import type * as schema from '../db/schema';
import { embed, embedSingle, isOllamaEnabled } from '../lib/ollama';

type DB = PostgresJsDatabase<typeof schema>;

const BOOKS_DIR =
	process.env.BOOKS_DIR || resolve(import.meta.dir, '../../data/books');

/** Run a command and return stdout as string. Throws on non-zero exit. */
async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${stderr.trim()}`);
	return stdout;
}

/** Get total page count from a PDF via pdfinfo. */
async function pdfPageCount(filePath: string): Promise<number> {
	const out = await run(['pdfinfo', filePath]);
	const match = out.match(/^Pages:\s+(\d+)/m);
	if (!match) throw new Error('Could not parse page count from pdfinfo');
	return Number.parseInt(match[1], 10);
}

/** Extract text for a single page via pdftotext. */
function pdfPageText(filePath: string, page: number): Promise<string> {
	return run([
		'pdftotext',
		'-layout',
		'-f',
		String(page),
		'-l',
		String(page),
		filePath,
		'-',
	]);
}

/** A chapter/section entry from the PDF outline (table of contents). */
export interface Chapter {
	title: string;
	page: number;
	children?: Chapter[];
}

/** Parse pdftohtml XML output and extract the outline tree. */
function parseOutline(xml: string): Chapter[] {
	const outlineStart = xml.indexOf('<outline>');
	if (outlineStart === -1) return [];

	const content = xml.slice(outlineStart);
	const chapters: Chapter[] = [];
	const stack: Chapter[][] = [chapters];
	let lastItem: Chapter | null = null;

	const regex = /<item page="(\d+)">(.*?)<\/item>|<outline>|<\/outline>/g;
	let depth = 0;

	for (
		let match = regex.exec(content);
		match !== null;
		match = regex.exec(content)
	) {
		if (match[0] === '<outline>') {
			if (depth > 0 && lastItem) {
				lastItem.children = [];
				stack.push(lastItem.children);
			}
			depth++;
		} else if (match[0] === '</outline>') {
			depth--;
			if (depth > 0) {
				stack.pop();
			}
		} else {
			const chapter: Chapter = {
				title: match[2]
					.trim()
					.replace(/&amp;/g, '&')
					.replace(/&lt;/g, '<')
					.replace(/&gt;/g, '>')
					.replace(/&quot;/g, '"')
					.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))),
				page: Number.parseInt(match[1], 10),
			};
			const currentList = stack[stack.length - 1];
			currentList.push(chapter);
			lastItem = chapter;
		}
	}

	return chapters;
}

/** Extract the PDF outline/bookmarks tree via pdftohtml. */
async function pdfOutline(filePath: string): Promise<Chapter[]> {
	try {
		const xml = await run(['pdftohtml', '-stdout', '-xml', filePath]);
		return parseOutline(xml);
	} catch {
		// pdftohtml not available or failed — chapters are optional
		return [];
	}
}

/** Index a PDF: extract text for every page, extract outline, store both. */
export async function indexBook(
	md5: string,
	filePath: string,
	raw: postgres.Sql,
): Promise<{ pages: number; chapters: Chapter[] }> {
	const totalPages = await pdfPageCount(filePath);

	for (let p = 1; p <= totalPages; p++) {
		const text = await pdfPageText(filePath, p);
		await raw`
			INSERT INTO book_pages (md5, page_number, content)
			VALUES (${md5}, ${p}, ${text})
			ON CONFLICT (md5, page_number) DO UPDATE SET content = EXCLUDED.content
		`;
	}

	// Extract chapter outline from PDF bookmarks
	const chapters = await pdfOutline(filePath);
	if (chapters.length > 0) {
		await raw`
			UPDATE books SET chapters = ${JSON.stringify(chapters)}::jsonb
			WHERE md5 = ${md5}
		`;
	}

	return { pages: totalPages, chapters };
}

/** Embed all un-embedded pages for a book. Batches of 10. */
export async function embedBook(
	md5: string,
	raw: postgres.Sql,
): Promise<{ embedded: number }> {
	const BATCH = 10;
	let embedded = 0;

	while (true) {
		const pages = await raw`
			SELECT id, content FROM book_pages
			WHERE md5 = ${md5} AND embedding IS NULL
			ORDER BY page_number
			LIMIT ${BATCH}
		`;
		if (pages.length === 0) break;

		const texts = pages.map((p) => String(p.content));
		const vectors = await embed(texts);

		for (let i = 0; i < pages.length; i++) {
			const vec = `[${vectors[i].join(',')}]`;
			await raw`
				UPDATE book_pages SET embedding = ${vec}::vector
				WHERE id = ${pages[i].id}
			`;
		}
		embedded += pages.length;
	}

	return { embedded };
}

export function readerRoutes(_db: DB, raw: postgres.Sql) {
	const app = new Hono();

	// GET /reader/:md5/status — book indexing and embedding status
	app.get('/reader/:md5/status', async (c) => {
		const { md5 } = c.req.param();

		const [book] = await raw`
			SELECT title, author, extension, downloaded_at, chapters
			FROM books WHERE md5 = ${md5} LIMIT 1
		`;
		if (!book) return c.json({ error: 'Book not found' }, 404);

		const [counts] = await raw`
			SELECT
				count(*)::int AS pages_extracted,
				count(embedding)::int AS pages_embedded
			FROM book_pages WHERE md5 = ${md5}
		`;

		const pagesExtracted = counts?.pages_extracted ?? 0;
		const pagesEmbedded = counts?.pages_embedded ?? 0;
		const chapters = (book.chapters as Chapter[] | null) ?? [];

		return c.json({
			md5,
			title: book.title,
			author: book.author,
			extension: book.extension,
			downloaded: book.downloaded_at != null,
			indexed: pagesExtracted > 0,
			pages_extracted: pagesExtracted,
			pages_embedded: pagesEmbedded,
			ready_for_search: pagesEmbedded > 0 && pagesEmbedded === pagesExtracted,
			chapters,
		});
	});

	// POST /reader/:md5/index — extract text from PDF pages
	// Pass ?force=true to re-index an already-indexed book
	app.post('/reader/:md5/index', async (c) => {
		const { md5 } = c.req.param();
		const force = c.req.query('force') === 'true';

		const [book] = await raw`
			SELECT extension, downloaded_at
			FROM books WHERE md5 = ${md5} LIMIT 1
		`;
		if (!book) return c.json({ error: 'Book not found' }, 404);
		if (!book.downloaded_at)
			return c.json({ error: 'Book not downloaded' }, 400);
		if (book.extension !== 'pdf')
			return c.json({ error: 'Only PDF books can be indexed' }, 400);

		// Skip if already indexed (unless forced)
		if (!force) {
			const [counts] = await raw`
				SELECT count(*)::int AS total FROM book_pages WHERE md5 = ${md5}
			`;
			if (counts?.total > 0)
				return c.json({
					ok: true,
					md5,
					pages: counts.total,
					message: 'Already indexed — use ?force=true to re-index',
				});
		}

		const filePath = resolve(BOOKS_DIR, `${md5}.pdf`);
		if (!existsSync(filePath))
			return c.json({ error: 'PDF file missing from disk' }, 404);

		try {
			const result = await indexBook(md5, filePath, raw);
			return c.json({ ok: true, md5, pages: result.pages });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Indexing failed', detail: msg }, 500);
		}
	});

	// POST /reader/:md5/embed — create embeddings for extracted pages
	app.post('/reader/:md5/embed', async (c) => {
		const { md5 } = c.req.param();

		if (!isOllamaEnabled())
			return c.json({ error: 'Ollama not configured (set OLLAMA_URL)' }, 503);

		const [counts] = await raw`
			SELECT count(*)::int AS total, count(embedding)::int AS embedded
			FROM book_pages WHERE md5 = ${md5}
		`;
		if (!counts || counts.total === 0)
			return c.json({ error: 'Book not indexed — run index first' }, 400);
		if (counts.total === counts.embedded)
			return c.json({
				ok: true,
				md5,
				embedded: 0,
				message: 'Already fully embedded',
			});

		try {
			const result = await embedBook(md5, raw);
			return c.json({ ok: true, md5, embedded: result.embedded });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Embedding failed', detail: msg }, 500);
		}
	});

	// GET /reader/:md5/page/:page — get extracted text for a page
	app.get('/reader/:md5/page/:page', async (c) => {
		const { md5 } = c.req.param();
		const page = Number.parseInt(c.req.param('page'), 10);
		if (Number.isNaN(page) || page < 1)
			return c.json({ error: 'Invalid page number' }, 400);

		const [row] = await raw`
			SELECT content FROM book_pages
			WHERE md5 = ${md5} AND page_number = ${page}
		`;
		if (!row) return c.json({ error: 'Page not found' }, 404);

		return c.json({ md5, page, content: row.content });
	});

	// GET /reader/:md5/page/:page/image — render page as PNG
	app.get('/reader/:md5/page/:page/image', async (c) => {
		const { md5 } = c.req.param();
		const page = Number.parseInt(c.req.param('page'), 10);
		if (Number.isNaN(page) || page < 1)
			return c.json({ error: 'Invalid page number' }, 400);

		const [book] = await raw`
			SELECT extension, downloaded_at
			FROM books WHERE md5 = ${md5} LIMIT 1
		`;
		if (!book) return c.json({ error: 'Book not found' }, 404);
		if (!book.downloaded_at)
			return c.json({ error: 'Book not downloaded' }, 400);
		if (book.extension !== 'pdf')
			return c.json({ error: 'Only PDF books supported' }, 400);

		const filePath = resolve(BOOKS_DIR, `${md5}.pdf`);
		if (!existsSync(filePath))
			return c.json({ error: 'PDF file missing from disk' }, 404);

		try {
			const tmpPrefix = resolve(BOOKS_DIR, `_tmp_${md5}_${page}`);
			await run([
				'pdftoppm',
				'-png',
				'-r',
				'150',
				'-f',
				String(page),
				'-l',
				String(page),
				'-singlefile',
				filePath,
				tmpPrefix,
			]);

			const pngPath = `${tmpPrefix}.png`;
			const file = Bun.file(pngPath);
			if (!(await file.exists()))
				return c.json({ error: 'Failed to render page' }, 500);

			const bytes = await file.arrayBuffer();
			// Clean up tmp file
			try {
				await Bun.write(pngPath, '');
				const { unlink } = await import('node:fs/promises');
				await unlink(pngPath);
			} catch {}

			return new Response(bytes, {
				headers: {
					'Content-Type': 'image/png',
					'Content-Disposition': `inline; filename="${md5}_p${page}.png"`,
				},
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Render failed', detail: msg }, 500);
		}
	});

	// GET /reader/:md5/search?q=... — semantic search within a book
	app.get('/reader/:md5/search', async (c) => {
		const { md5 } = c.req.param();
		const q = c.req.query('q');
		if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);

		if (!isOllamaEnabled())
			return c.json({ error: 'Ollama not configured (set OLLAMA_URL)' }, 503);

		const limit = Math.min(
			Number.parseInt(c.req.query('limit') || '5', 10),
			20,
		);

		try {
			const vec = await embedSingle(q);
			const vecStr = `[${vec.join(',')}]`;

			const results = await raw`
				SELECT page_number, content,
					embedding <=> ${vecStr}::vector AS distance
				FROM book_pages
				WHERE md5 = ${md5} AND embedding IS NOT NULL
				ORDER BY embedding <=> ${vecStr}::vector
				LIMIT ${limit}
			`;

			return c.json({
				md5,
				query: q,
				count: results.length,
				results: results.map((r) => ({
					page: r.page_number,
					distance: r.distance,
					content: r.content,
				})),
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Search failed', detail: msg }, 500);
		}
	});

	return app;
}
