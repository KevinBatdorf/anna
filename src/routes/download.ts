import { Hono } from 'hono';

const ANNAS_BASE_URL = process.env.ANNAS_BASE_URL || 'https://annas-archive.gl';
const ANNAS_API_KEY = process.env.ANNAS_API_KEY || '';

export function downloadRoutes() {
	const app = new Hono();

	app.get('/download', async (c) => {
		const md5 = c.req.query('md5');
		if (!md5) return c.json({ error: 'Missing ?md5= parameter' }, 400);
		if (!ANNAS_API_KEY) {
			return c.json(
				{
					error: 'ANNAS_API_KEY not configured',
					hint: "Set ANNAS_API_KEY in your .env file. Get a key by donating at the Anna's Archive website (/donate).",
				},
				503,
			);
		}

		try {
			const url = `${ANNAS_BASE_URL}/dyn/api/fast_download.json?md5=${encodeURIComponent(md5)}&key=${encodeURIComponent(ANNAS_API_KEY)}`;
			const res = await fetch(url, {
				signal: AbortSignal.timeout(30_000),
			});
			const data = await res.json();
			if (!res.ok) return c.json(data, 502);
			return c.json(data);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			return c.json({ error: 'Download request failed', detail: msg }, 502);
		}
	});

	return app;
}
