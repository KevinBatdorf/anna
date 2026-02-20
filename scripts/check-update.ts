import { runEmbedGoodreads } from './embed-goodreads';
import { runImportBooks } from './import-books';
import { runImportGoodreads } from './import-goodreads';
import { runMigrateFts } from './migrate-fts';

const ANNAS_BASE_URL = process.env.ANNAS_BASE_URL || 'https://annas-archive.li';
const TORRENTS_URL = `${ANNAS_BASE_URL}/dyn/torrents.json`;
const SOURCES = ['zlib3_records', 'goodreads_records'];
const ARIA2_URL = process.env.ARIA2_URL || 'http://anna-aria2:6800/jsonrpc';
const ARIA2_SECRET = process.env.ARIA2_SECRET || 'anna';
const DATA_DIR = process.env.DATA_DIR || '/data/torrents';
const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';
const STATE_FILE = '/data/update-state.json';
const CHECK_INTERVAL = 24 * 60 * 60_000; // check daily
const UPDATE_MIN_DAYS = parseInt(process.env.UPDATE_INTERVAL_DAYS || '30', 10);
const IMPORT_LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const ARIA2_POLL_INTERVAL = 60_000; // check aria2 every 60s

interface Torrent {
	display_name: string;
	magnet_link: string;
	data_size: number;
	obsolete: boolean;
	added_to_torrents_list_at: string;
}

interface State {
	last_download_at?: string;
	sources?: Record<string, string[]>;
	[key: string]: string | string[] | Record<string, string[]> | undefined;
}

async function getTorrents(): Promise<Map<string, Torrent[]>> {
	const res = await fetch(TORRENTS_URL, {
		signal: AbortSignal.timeout(60_000),
	});
	const data: Torrent[] = await res.json();

	const bySource = new Map<string, Torrent[]>();
	for (const source of SOURCES) {
		const matches = data
			.filter((t) => t.display_name.includes(source) && !t.obsolete)
			.sort((a, b) =>
				a.added_to_torrents_list_at.localeCompare(b.added_to_torrents_list_at),
			);
		if (matches.length > 0) {
			bySource.set(source, matches);
		}
	}
	return bySource;
}

async function getState(): Promise<State> {
	try {
		const file = Bun.file(STATE_FILE);
		if (await file.exists()) return await file.json();
	} catch {
		/* no state yet */
	}
	return {};
}

async function saveState(state: State) {
	await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

function getKnownFiles(state: State): Set<string> {
	const known = new Set<string>();

	if (state.sources) {
		for (const files of Object.values(state.sources)) {
			for (const f of files) known.add(f);
		}
	}

	// Legacy format compat
	for (const [key, val] of Object.entries(state)) {
		if (key === 'sources' || key === 'last_download_at') continue;
		if (typeof val === 'string') known.add(val);
		if (Array.isArray(val)) {
			for (const f of val) known.add(f);
		}
	}

	return known;
}

function daysSince(isoDate: string): number {
	return (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
}

async function aria2Call(
	method: string,
	params: unknown[] = [],
): Promise<unknown> {
	const res = await fetch(ARIA2_URL, {
		method: 'POST',
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 'anna-update',
			method,
			params: [`token:${ARIA2_SECRET}`, ...params],
		}),
	});
	const json: { result: unknown } = await res.json();
	return json.result;
}

/** Wait for all active/waiting aria2 downloads to finish */
async function waitForDownloads(): Promise<void> {
	console.log('  Waiting for aria2 downloads to complete...');

	while (true) {
		const active = (await aria2Call('aria2.tellActive')) as unknown[];
		const waiting = (await aria2Call(
			'aria2.tellWaiting',
			[0, 100],
		)) as unknown[];

		const pending = active.length + waiting.length;
		if (pending === 0) {
			console.log('  All downloads complete.');
			return;
		}

		console.log(
			`  ${pending} download(s) still in progress, checking again in 60s...`,
		);
		await Bun.sleep(ARIA2_POLL_INTERVAL);
	}
}

async function runImports() {
	console.log('\n--- Running imports ---');

	try {
		runMigrateFts({ dbPath: DB_PATH });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		console.error(`FTS migration failed: ${msg}`);
	}

	try {
		await runImportBooks({
			dataDir: DATA_DIR,
			dbPath: DB_PATH,
			limit: IMPORT_LIMIT,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		console.error(`Book import failed: ${msg}`);
	}

	try {
		await runImportGoodreads({
			dataDir: DATA_DIR,
			dbPath: DB_PATH,
			limit: IMPORT_LIMIT,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		console.error(`Goodreads import failed: ${msg}`);
	}

	try {
		await runEmbedGoodreads({ dbPath: DB_PATH });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : 'Unknown error';
		console.error(`Embedding pass failed: ${msg}`);
	}

	console.log('--- Imports finished ---\n');
}

async function check() {
	console.log(`[${new Date().toISOString()}] Checking for updates...`);

	const state = await getState();

	// Throttle: skip downloading if last download was too recent
	if (state.last_download_at) {
		const days = daysSince(state.last_download_at);
		if (days < UPDATE_MIN_DAYS) {
			console.log(
				`  Last download was ${Math.round(days)}d ago (min interval: ${UPDATE_MIN_DAYS}d). Skipping.`,
			);
			// Still try to import in case there are unimported files from a previous run
			await runImports();
			return;
		}
	}

	const bySource = await getTorrents();
	const known = getKnownFiles(state);
	let downloaded = false;

	if (!state.sources) state.sources = {};

	for (const [source, torrents] of bySource) {
		const newTorrents = torrents.filter((t) => !known.has(t.display_name));
		if (newTorrents.length === 0) {
			console.log(`  ${source}: up to date (${torrents.length} files tracked)`);
			continue;
		}

		console.log(`  ${source}: ${newTorrents.length} new file(s) to download`);

		for (const torrent of newTorrents) {
			const sizeGb = (torrent.data_size / 1024 ** 3).toFixed(1);
			try {
				const result = (await aria2Call('aria2.addUri', [
					[torrent.magnet_link],
				])) as string;
				console.log(
					`  Started: ${torrent.display_name} (${sizeGb} GB) [${result}]`,
				);
				downloaded = true;
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : 'Unknown error';
				console.log(`  Failed: ${torrent.display_name} — ${msg}`);
			}
		}

		state.sources[source] = torrents.map((t) => t.display_name);
	}

	if (downloaded) {
		state.last_download_at = new Date().toISOString();
		await saveState(state);

		// Wait for downloads to finish, then import
		await waitForDownloads();
		await runImports();
	} else {
		await saveState(state);
		// Even if no new downloads, try importing (files may have finished from a previous run)
		await runImports();
	}
}

/** Start the update checker loop (run immediately, then on interval). */
export function startUpdateLoop() {
	console.log(
		`Update checker running (every 24h, min download interval: ${UPDATE_MIN_DAYS}d)`,
	);
	check();
	setInterval(check, CHECK_INTERVAL);
}

// Allow running directly as a script
if (import.meta.main) {
	startUpdateLoop();
}
