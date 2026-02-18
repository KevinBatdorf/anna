const TORRENTS_URL = 'https://annas-archive.li/dyn/torrents.json';
const SOURCES = ['zlib3_records', 'goodreads_records'];
const ARIA2_URL = process.env.ARIA2_URL || 'http://anna-aria2:6800/jsonrpc';
const ARIA2_SECRET = process.env.ARIA2_SECRET || 'anna';
const NTFY_URL = process.env.NTFY_URL || 'http://host.docker.internal:2586';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const STATE_FILE = '/data/update-state.json';
const CHECK_INTERVAL = 24 * 60 * 60_000; // 24h

interface Torrent {
	display_name: string;
	magnet_link: string;
	data_size: number;
	obsolete: boolean;
	added_to_torrents_list_at: string;
}

async function notify(
	topic: string,
	title: string,
	message: string,
	tags = '',
) {
	const headers: Record<string, string> = { Title: title };
	if (tags) headers.Tags = tags;
	if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;

	try {
		await fetch(`${NTFY_URL}/${topic}`, {
			method: 'POST',
			headers,
			body: message,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		console.log(`  ntfy error (${topic}): ${msg}`);
	}
}

async function getLatestTorrents(): Promise<Map<string, Torrent>> {
	const res = await fetch(TORRENTS_URL, {
		signal: AbortSignal.timeout(60_000),
	});
	const data: Torrent[] = await res.json();

	const latest = new Map<string, Torrent>();
	for (const source of SOURCES) {
		const matches = data
			.filter((t) => t.display_name.includes(source) && !t.obsolete)
			.sort((a, b) =>
				b.added_to_torrents_list_at.localeCompare(a.added_to_torrents_list_at),
			);
		if (matches.length > 0) {
			latest.set(source, matches[0]);
		}
	}
	return latest;
}

async function getState(): Promise<Record<string, string>> {
	try {
		const file = Bun.file(STATE_FILE);
		if (await file.exists()) return await file.json();
	} catch {
		/* no state yet */
	}
	return {};
}

async function saveState(state: Record<string, string>) {
	await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function check() {
	console.log(`[${new Date().toISOString()}] Checking for updates...`);
	const latest = await getLatestTorrents();
	const state = await getState();
	let updated = false;

	for (const [source, torrent] of latest) {
		const currentFile = state[source];
		if (currentFile === torrent.display_name) {
			console.log(`  ${source}: up to date (${torrent.display_name})`);
			continue;
		}

		console.log(`  ${source}: new version available! ${torrent.display_name}`);
		const sizeGb = (torrent.data_size / 1024 ** 3).toFixed(1);

		try {
			const res = await fetch(ARIA2_URL, {
				method: 'POST',
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'anna-update',
					method: 'aria2.addUri',
					params: [`token:${ARIA2_SECRET}`, [torrent.magnet_link]],
				}),
			});
			const result: { result: string } = await res.json();
			console.log(`  Started download: ${result.result}`);

			await notify(
				'alerts',
				`Anna: new ${source}`,
				`${torrent.display_name} (${sizeGb} GB) — download started`,
				'books',
			);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : 'Unknown error';
			console.log(`  Failed to start download: ${msg}`);
			await notify(
				'alerts',
				`Anna: update failed`,
				`Could not start download for ${source}: ${msg}`,
				'warning',
			);
		}

		state[source] = torrent.display_name;
		updated = true;
	}

	if (updated) await saveState(state);
}

// Run immediately, then on interval
check();
setInterval(check, CHECK_INTERVAL);
console.log(`Update checker running (every ${CHECK_INTERVAL / 3600_000}h)`);
