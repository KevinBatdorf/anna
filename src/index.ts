import { Hono } from 'hono';
import { db, raw } from './db';
import { downloadRoutes } from './routes/download';
import { libraryRoutes } from './routes/library';
import { lookupRoutes } from './routes/lookup';
import { mcpRoutes } from './routes/mcp';
import { readerRoutes } from './routes/reader';
import { searchRoutes } from './routes/search';
import { similarRoutes } from './routes/similar';
import { statsRoutes } from './routes/stats';

const app = new Hono();

app.route('/', searchRoutes(db, raw));
app.route('/', similarRoutes(db, raw));
app.route('/', lookupRoutes(db));
app.route('/', statsRoutes(raw));
app.route('/', downloadRoutes());
app.route('/', libraryRoutes(db, raw));
app.route('/', readerRoutes(db, raw));
mcpRoutes(app);

app.get('/', (c) =>
	c.json({
		name: "Anna's Archive Search API",
		endpoints: [
			'GET /search?q=...&limit=20&offset=0',
			'GET /search/goodreads?q=...&limit=20&offset=0',
			'GET /similar?q=...&limit=10&min_rating=0&min_reviews=0',
			'GET /lookup/md5?md5=...',
			'GET /lookup/isbn?isbn=...',
			'GET /download?md5=...',
			'GET /library',
			'GET /library/search?q=...',
			'POST /library/download?md5=...',
			'GET /library/:md5/file',
			'DELETE /library/:md5',
			'GET /reader/:md5/status',
			'POST /reader/:md5/index',
			'GET /reader/:md5/page/:page',
			'POST /reader/:md5/embed',
			'GET /reader/:md5/search?q=...',
			'GET /reader/:md5/page/:page/image',
			'GET /stats',
			'POST /mcp (MCP protocol endpoint)',
		],
	}),
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default {
	fetch: app.fetch,
	port: 3100,
	idleTimeout: 120,
};
