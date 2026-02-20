import { Hono } from 'hono';
import { startUpdateLoop } from '../scripts/check-update';
import { db, raw } from './db';
import { downloadRoutes } from './routes/download';
import { lookupRoutes } from './routes/lookup';
import { mcpRoutes } from './routes/mcp';
import { searchRoutes } from './routes/search';
import { similarRoutes } from './routes/similar';
import { statsRoutes } from './routes/stats';

const app = new Hono();

app.route('/', searchRoutes(db, raw));
app.route('/', similarRoutes(db, raw));
app.route('/', lookupRoutes(db));
app.route('/', statsRoutes(db));
app.route('/', downloadRoutes());
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
			'GET /stats',
			'POST /mcp (MCP protocol endpoint)',
		],
	}),
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Start update checker in-process (same process = safe SQLite access)
if (import.meta.main) {
	startUpdateLoop();
}

export default app;
