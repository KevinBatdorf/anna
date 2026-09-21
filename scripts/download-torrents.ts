/**
 * Check Anna's Archive for new torrent files and download them via aria2.
 * That's it. Run imports separately.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { fetchTorrents } from './lib/annas';
import { notify } from './lib/ntfy';

const logPath = `${import.meta.dirname}/../data/download-torrents.log`;
const torrentsDir = `${import.meta.dirname}/../data/torrents`;

function log(msg: string) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	process.stdout.write(line);
	// Append — Bun.file().writer() truncates, which used to wipe the log on
	// every run and left nothing to debug with.
	appendFileSync(logPath, line);
}

const ANNAS_BASE_URL = process.env.ANNAS_BASE_URL || 'https://annas-archive.gl';
const SOURCES = ['zlib3_records', 'goodreads_records'];
const ARIA2_URL = process.env.ARIA2_URL || 'http://anna-aria2:6800/jsonrpc';
const ARIA2_SECRET = process.env.ARIA2_SECRET || 'anna';

async function aria2Call(
	method: string,
	params: unknown[] = [],
): Promise<unknown> {
	const res = await fetch(ARIA2_URL, {
		method: 'POST',
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 'anna',
			method,
			params: [`token:${ARIA2_SECRET}`, ...params],
		}),
	});
	if (!res.ok) throw new Error(`aria2 HTTP ${res.status} ${res.statusText}`);
	const json: { result?: unknown; error?: { message: string } } =
		await res.json();
	if (json.error) throw new Error(`aria2: ${json.error.message}`);
	return json.result;
}

/**
 * True when we already hold the finished payload. aria2 leaves a .aria2
 * control file next to anything still in flight, so its absence is what
 * marks the download as complete.
 */
function alreadyHave(displayName: string): boolean {
	const payload = `${torrentsDir}/${displayName.replace(/\.torrent$/, '')}`;
	return existsSync(payload) && !existsSync(`${payload}.aria2`);
}

let result: Awaited<ReturnType<typeof fetchTorrents>>;
try {
	result = await fetchTorrents(ANNAS_BASE_URL, log);
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	log(`FAILED to fetch torrent list — ${msg}`);
	await notify(
		'alerts',
		'anna: torrent sync failed',
		`Could not fetch torrents.json.\n\n${msg}`,
		'warning,books',
		'high',
	);
	process.exit(1);
}

const { baseUrl, torrents: data } = result;
if (baseUrl !== ANNAS_BASE_URL) {
	log(`note: ${ANNAS_BASE_URL} failed, used ${baseUrl} instead`);
	await notify(
		'alerts',
		'anna: using fallback mirror',
		`${ANNAS_BASE_URL} is not answering. Succeeded via ${baseUrl}.\nConsider setting ANNAS_BASE_URL=${baseUrl}`,
		'globe_with_meridians,books',
	);
}

const started: string[] = [];
const problems: string[] = [];

for (const source of SOURCES) {
	const torrents = data
		.filter((t) => t.display_name.includes(source) && !t.obsolete)
		.toSorted((a, b) => a.display_name.localeCompare(b.display_name));

	if (torrents.length === 0) {
		log(`${source}: no torrents found`);
		problems.push(`${source}: no torrents found`);
		continue;
	}

	// Just grab the latest one
	const latest = torrents[torrents.length - 1];
	const sizeGb = (latest.data_size / 1024 ** 3).toFixed(1);

	if (alreadyHave(latest.display_name)) {
		log(`${source}: already have ${latest.display_name}, skipping`);
		continue;
	}

	try {
		const gid = await aria2Call('aria2.addUri', [[latest.magnet_link]]);
		log(
			`${source}: downloading ${latest.display_name} (${sizeGb} GB) [${gid}]`,
		);
		started.push(`${latest.display_name} (${sizeGb} GB)`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log(`${source}: failed — ${msg}`);
		problems.push(`${source}: ${msg}`);
	}
}

if (started.length) {
	await notify(
		'alerts',
		'anna: new metadata dump',
		`Started ${started.length} download(s):\n${started.join('\n')}`,
		'inbox_tray,books',
	);
}

if (problems.length) {
	await notify(
		'alerts',
		'anna: torrent sync problems',
		problems.join('\n'),
		'warning,books',
		'high',
	);
	process.exit(1);
}
