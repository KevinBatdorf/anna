/**
 * Resolve the current working Anna's Archive domain.
 *
 * 1. Fetches the Wikipedia page for Anna's Archive
 * 2. Extracts candidate annas-archive.* URLs
 * 3. Tests each by hitting /dyn/torrents.json
 * 4. Prints the first working domain
 */

const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/Anna%27s_Archive';

async function extractCandidates(): Promise<string[]> {
	console.log('Fetching Wikipedia page...');
	const res = await fetch(WIKIPEDIA_URL, {
		signal: AbortSignal.timeout(15_000),
	});
	const html = await res.text();

	// Extract all annas-archive.* domains from the page
	const matches = html.matchAll(/https?:\/\/annas-archive\.(\w+)/g);
	const seen = new Set<string>();
	const candidates: string[] = [];

	for (const m of matches) {
		const url = `https://annas-archive.${m[1]}`;
		if (!seen.has(url)) {
			seen.add(url);
			candidates.push(url);
		}
	}

	return candidates;
}

async function testDomain(base: string): Promise<boolean> {
	try {
		const res = await fetch(`${base}/dyn/torrents.json`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return false;
		const data = await res.json();
		return Array.isArray(data) && data.length > 0;
	} catch {
		return false;
	}
}

async function main() {
	const candidates = await extractCandidates();
	if (candidates.length === 0) {
		console.error('No candidate domains found on Wikipedia.');
		process.exit(1);
	}

	console.log(
		`Found ${candidates.length} candidate(s): ${candidates.join(', ')}`,
	);

	for (const url of candidates) {
		process.stdout.write(`  Testing ${url} ... `);
		const ok = await testDomain(url);
		console.log(ok ? 'OK' : 'FAILED');

		if (ok) {
			console.log(`\nWorking domain: ${url}`);
			console.log(`Set ANNAS_BASE_URL=${url} in your .env`);
			return;
		}
	}

	console.error('\nNo working domain found. Check Wikipedia manually.');
	process.exit(1);
}

main();
