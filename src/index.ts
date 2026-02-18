import { Hono } from 'hono';
import { db } from './db';
import { lookupRoutes } from './routes/lookup';
import { recommendRoutes } from './routes/recommend';
import { searchRoutes } from './routes/search';
import { statsRoutes } from './routes/stats';

const app = new Hono();

app.route('/', searchRoutes(db));
app.route('/', recommendRoutes(db));
app.route('/', lookupRoutes(db));
app.route('/', statsRoutes(db));

app.get('/', (c) =>
	c.json({
		name: "Anna's Archive Search API",
		endpoints: [
			'GET /search?q=...&limit=20&offset=0',
			'GET /search/goodreads?q=...&limit=20&offset=0',
			'GET /recommend?q=...&limit=10',
			'GET /lookup/md5?md5=...',
			'GET /lookup/isbn?isbn=...',
			'GET /stats',
		],
	}),
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
