/**
 * Fetching torrents.json from Anna's Archive, defensively.
 *
 * The site sits behind DDoS-Guard, which answers a challenged request with an
 * HTML page and a 200, not an error status. Parsing that as JSON is what broke
 * the nightly sync silently for ~170 runs: the body was discarded and all that
 * surfaced was `SyntaxError: Failed to parse JSON`. So every response here is
 * checked and the body is kept for the error message.
 */

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/Anna%27s_Archive';
const KNOWN_MIRRORS = [
	'https://annas-archive.org',
	'https://annas-archive.se',
	'https://annas-archive.li',
];
// torrents.json is ~20 MB, so the body read needs real headroom.
const TIMEOUT_MS = 120_000;
const ATTEMPTS_PER_DOMAIN = 3;
const BACKOFF_MS = 5_000;

export interface Torrent {
	display_name: string;
	magnet_link: string;
	data_size: number;
	obsolete: boolean;
}

export interface TorrentsResult {
	baseUrl: string;
	torrents: Torrent[];
}

function snippet(body: string): string {
	const flat = body.replace(/\s+/g, ' ').trim();
	return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One attempt. Throws with a message that says what actually came back. */
async function fetchOnce(baseUrl: string): Promise<Torrent[]> {
	const res = await fetch(`${baseUrl}/dyn/torrents.json`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});

	const body = await res.text();

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText} — ${snippet(body)}`);
	}

	const contentType = res.headers.get('content-type') ?? '';
	if (!contentType.includes('json')) {
		const guard = res.headers.get('server') ?? 'unknown';
		throw new Error(
			`expected JSON, got "${contentType}" from server "${guard}" — ${snippet(body)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error(
			`malformed JSON in ${body.length} bytes — ${snippet(body)}`,
		);
	}

	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(`expected a non-empty array — ${snippet(body)}`);
	}

	return parsed as Torrent[];
}

/**
 * Candidate domains, best first: the configured one, then whatever Wikipedia
 * currently lists, then the mirrors we know about. Anna's Archive rotates
 * domains, so a hardcoded base URL goes stale on its own schedule.
 */
async function candidateDomains(preferred: string): Promise<string[]> {
	const seen = new Set<string>();
	const out: string[] = [];

	const add = (url: string) => {
		const clean = url.replace(/\/+$/, '');
		if (!seen.has(clean)) {
			seen.add(clean);
			out.push(clean);
		}
	};

	if (preferred) add(preferred);

	try {
		const res = await fetch(WIKIPEDIA_URL, {
			headers: { 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(15_000),
		});
		if (res.ok) {
			const html = await res.text();
			for (const m of html.matchAll(/https?:\/\/annas-archive\.(\w+)/g)) {
				add(`https://annas-archive.${m[1]}`);
			}
		}
	} catch {
		// Wikipedia is a convenience, not a dependency.
	}

	for (const m of KNOWN_MIRRORS) add(m);

	return out;
}

/**
 * Fetch the torrent list, trying each candidate domain a few times.
 * Throws with the full attempt log if every domain fails.
 */
export async function fetchTorrents(
	preferredBaseUrl: string,
	log: (msg: string) => void,
): Promise<TorrentsResult> {
	const domains = await candidateDomains(preferredBaseUrl);
	const failures: string[] = [];

	for (const baseUrl of domains) {
		for (let attempt = 1; attempt <= ATTEMPTS_PER_DOMAIN; attempt++) {
			try {
				const torrents = await fetchOnce(baseUrl);
				log(`${baseUrl}: fetched ${torrents.length} torrents`);
				return { baseUrl, torrents };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				failures.push(`${baseUrl} (attempt ${attempt}): ${msg}`);
				log(
					`${baseUrl}: attempt ${attempt}/${ATTEMPTS_PER_DOMAIN} failed — ${msg}`,
				);
				if (attempt < ATTEMPTS_PER_DOMAIN) await sleep(BACKOFF_MS * attempt);
			}
		}
	}

	throw new Error(
		`all ${domains.length} domain(s) failed:\n${failures.join('\n')}`,
	);
}
