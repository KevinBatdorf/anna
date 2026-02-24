import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Hono } from 'hono';
import { z } from 'zod';

/**
 * Register MCP tools that proxy to the existing Hono app.
 * Uses app.request() internally so no external HTTP calls are needed.
 */
function registerTools(server: McpServer, app: Hono) {
	server.registerTool(
		'search_books',
		{
			title: 'Search Books',
			description:
				"Search for books in Anna's Archive by keyword and/or filters. Returns title, author, format, MD5, ISBN, and more. Results are deduplicated by default, preferring PDF > epub. You can combine a text query with filters, or use filters alone.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe(
						'Full-text search query (searches title, author, publisher, description, ISBN)',
					),
				author: z
					.string()
					.optional()
					.describe('Filter by author name (partial match)'),
				publisher: z
					.string()
					.optional()
					.describe(
						'Filter by publisher name (partial match, e.g. "No Starch")',
					),
				language: z
					.string()
					.optional()
					.describe(
						'Filter by language (exact match, e.g. "english", "french")',
					),
				year: z
					.string()
					.optional()
					.describe('Filter by publication year (exact match, e.g. "2024")'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(10)
					.describe('Max results to return'),
				offset: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe('Offset for pagination'),
				ext: z
					.string()
					.optional()
					.describe('Filter by file extension (pdf, epub, etc.)'),
			},
		},
		async ({
			query,
			author,
			publisher,
			language,
			year,
			limit,
			offset,
			ext,
		}) => {
			const params = new URLSearchParams({
				limit: String(limit),
				offset: String(offset),
			});
			if (query) params.set('q', query);
			if (author) params.set('author', author);
			if (publisher) params.set('publisher', publisher);
			if (language) params.set('language', language);
			if (year) params.set('year', year);
			if (ext) params.set('ext', ext);
			const res = await app.request(`/search?${params}`);
			const data = await res.json();
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
			};
		},
	);

	server.registerTool(
		'search_goodreads',
		{
			title: 'Search Goodreads',
			description:
				'Search the Goodreads catalog for books with ratings, reviews, and descriptions. Uses vector search when available (plain query only), otherwise full-text search. Supports filtering by author, year, and genre.',
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe(
						'Full-text search query (title, author, description, genre)',
					),
				author: z
					.string()
					.optional()
					.describe('Filter by author name (partial match)'),
				year: z
					.string()
					.optional()
					.describe('Filter by publication year (exact match)'),
				genre: z
					.string()
					.optional()
					.describe(
						'Filter by genre (partial match, e.g. "fantasy", "science fiction")',
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(10)
					.describe('Max results to return'),
				offset: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe('Offset for pagination'),
			},
		},
		async ({ query, author, year, genre, limit, offset }) => {
			const params = new URLSearchParams({
				limit: String(limit),
				offset: String(offset),
			});
			if (query) params.set('q', query);
			if (author) params.set('author', author);
			if (year) params.set('year', year);
			if (genre) params.set('genre', genre);
			const res = await app.request(`/search/goodreads?${params}`);
			const data = await res.json();
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
			};
		},
	);

	server.registerTool(
		'find_similar',
		{
			title: 'Find Similar Books',
			description:
				'Find books similar to a given book using vector embeddings. Pass an ISBN for the most accurate match, or a book title. The title must closely match a Goodreads entry — partial or vague titles may return found:false. Returns Goodreads entries ranked by similarity, with available:true/false indicating downloadable copies.',
			inputSchema: {
				query: z
					.string()
					.describe(
						'ISBN (preferred, most accurate) or exact book title to find similar books for',
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(10)
					.describe('Max results to return'),
				min_rating: z
					.number()
					.min(0)
					.max(5)
					.default(0)
					.describe('Minimum Goodreads rating (0-5)'),
				min_reviews: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe('Minimum number of Goodreads ratings'),
			},
		},
		async ({ query, limit, min_rating, min_reviews }) => {
			const params = new URLSearchParams({
				q: query,
				limit: String(limit),
				min_rating: String(min_rating),
				min_reviews: String(min_reviews),
			});
			const res = await app.request(`/similar?${params}`);
			const data = await res.json();
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
			};
		},
	);

	server.registerTool(
		'lookup_isbn',
		{
			title: 'Lookup by ISBN',
			description:
				"Look up a book by ISBN. Returns both the Anna's Archive download entry and Goodreads metadata if available.",
			inputSchema: {
				isbn: z.string().describe('ISBN-10 or ISBN-13'),
			},
		},
		async ({ isbn }) => {
			const res = await app.request(
				`/lookup/isbn?isbn=${encodeURIComponent(isbn)}`,
			);
			const data = await res.json();
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
			};
		},
	);

	server.registerTool(
		'lookup_md5',
		{
			title: 'Lookup by MD5',
			description:
				'Look up a specific book file by its MD5 hash. Returns full metadata including download info.',
			inputSchema: {
				md5: z.string().describe('MD5 hash of the book file'),
			},
		},
		async ({ md5 }) => {
			const res = await app.request(
				`/lookup/md5?md5=${encodeURIComponent(md5)}`,
			);
			const data = await res.json();
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
			};
		},
	);

	server.registerTool(
		'get_stats',
		{
			title: 'Get Stats',
			description:
				'Get database statistics: total books, Goodreads entries, and embedding progress.',
			inputSchema: {},
		},
		async () => {
			const res = await app.request('/stats');
			const data = await res.json();
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
			};
		},
	);

	server.registerTool(
		'get_download_url',
		{
			title: 'Get Download URL',
			description:
				'Get a direct download URL for a book file by MD5 hash. Returns a temporary URL, suggested filename, and file metadata. Use a file download tool (e.g. mcp-url-downloader) to save the file. Requires ANNAS_API_KEY to be configured.',
			inputSchema: {
				md5: z.string().describe('MD5 hash of the book file'),
			},
		},
		async ({ md5 }) => {
			const res = await app.request(`/download?md5=${encodeURIComponent(md5)}`);
			const data = await res.json();

			if (!res.ok || data.error) {
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(
								{
									error: data.error ?? 'Download URL request failed',
									detail: data,
								},
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}

			// Include book metadata for a good filename suggestion
			const lookupRes = await app.request(
				`/lookup/md5?md5=${encodeURIComponent(md5)}`,
			);
			const lookupData = await lookupRes.json();
			const book = lookupData?.book;
			const ext = book?.extension || 'bin';
			const title = book?.title?.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || md5;
			const author = book?.author?.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
			const basename = author ? `${title} - ${author}` : title;
			const filename = `${basename.slice(0, 200)}.${ext}`;

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								...data,
								suggested_filename: filename,
								md5,
								extension: ext,
								title: book?.title ?? null,
								author: book?.author ?? null,
								filesize: book?.filesize ?? null,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

/** Create a connected MCP server+client pair for handling a single request. */
async function createMcpPair(app: Hono) {
	const server = new McpServer(
		{ name: 'anna-archive', version: '1.0.0' },
		{ capabilities: { logging: {} } },
	);
	registerTools(server, app);

	const client = new Client({ name: 'anna-proxy', version: '1.0.0' });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);

	return {
		server,
		client,
		close: () => {
			server.close();
			client.close();
		},
	};
}

export function mcpRoutes(app: Hono) {
	app.post('/mcp', async (c) => {
		const body = await c.req.json();
		const { method, params, id } = body;

		if (!method || !id) {
			return c.json(
				{
					jsonrpc: '2.0',
					error: { code: -32600, message: 'Invalid request' },
					id: id ?? null,
				},
				400,
			);
		}

		const pair = await createMcpPair(app);
		try {
			if (method === 'initialize') {
				// MCP initialization handshake
				const result = await pair.client.getServerVersion();
				return c.json({ jsonrpc: '2.0', result, id });
			}

			if (method === 'tools/list') {
				const result = await pair.client.listTools();
				return c.json({ jsonrpc: '2.0', result, id });
			}

			if (method === 'tools/call') {
				const result = await pair.client.callTool({
					name: params?.name,
					arguments: params?.arguments ?? {},
				});
				return c.json({ jsonrpc: '2.0', result, id });
			}

			return c.json(
				{
					jsonrpc: '2.0',
					error: { code: -32601, message: `Method not found: ${method}` },
					id,
				},
				400,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json(
				{ jsonrpc: '2.0', error: { code: -32603, message: msg }, id },
				500,
			);
		} finally {
			pair.close();
		}
	});

	// GET /mcp — list available tools for discovery
	app.get('/mcp', (c) => {
		return c.json({
			name: 'anna-archive',
			version: '1.0.0',
			description: "MCP server for Anna's Archive book search",
			tools: [
				'search_books',
				'search_goodreads',
				'find_similar',
				'lookup_isbn',
				'lookup_md5',
				'get_stats',
				'get_download_url',
			],
			usage: 'POST JSON-RPC 2.0 requests to this endpoint',
		});
	});
}
