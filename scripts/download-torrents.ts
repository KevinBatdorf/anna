/**
 * Check Anna's Archive for new torrent files and download them via aria2.
 * That's it. Run imports separately.
 */
export {};

const logPath = `${import.meta.dirname}/../data/download-torrents.log`;
const logStream = Bun.file(logPath).writer();

function log(msg: string) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	process.stdout.write(line);
	logStream.write(line);
	logStream.flush();
}

const ANNAS_BASE_URL = process.env.ANNAS_BASE_URL || 'https://annas-archive.pk';
const TORRENTS_URL = `${ANNAS_BASE_URL}/dyn/torrents.json`;
const SOURCES = ['zlib3_records', 'goodreads_records'];
const ARIA2_URL = process.env.ARIA2_URL || 'http://anna-aria2:6800/jsonrpc';
const ARIA2_SECRET = process.env.ARIA2_SECRET || 'anna';

interface Torrent {
	display_name: string;
	magnet_link: string;
	data_size: number;
	obsolete: boolean;
}

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
	const json: { result: unknown } = await res.json();
	return json.result;
}

const res = await fetch(TORRENTS_URL, { signal: AbortSignal.timeout(60_000) });
const data: Torrent[] = await res.json();

for (const source of SOURCES) {
	const torrents = data
		.filter((t) => t.display_name.includes(source) && !t.obsolete)
		.toSorted((a, b) => a.display_name.localeCompare(b.display_name));

	if (torrents.length === 0) {
		log(`${source}: no torrents found`);
		continue;
	}

	// Just grab the latest one
	const latest = torrents[torrents.length - 1];
	const sizeGb = (latest.data_size / 1024 ** 3).toFixed(1);

	try {
		const result = await aria2Call('aria2.addUri', [[latest.magnet_link]]);
		log(
			`${source}: downloading ${latest.display_name} (${sizeGb} GB) [${result}]`,
		);
	} catch (e) {
		log(`${source}: failed — ${e instanceof Error ? e.message : e}`);
	}
}
