import { readdir } from 'node:fs/promises';

/**
 * Find all complete .zst data files for a given source,
 * sorted chronologically (oldest first — filenames contain ISO dates).
 *
 * Skips files still being downloaded (those with a matching .aria2 file).
 */
export async function findDataFiles(
	dataDir: string,
	source: string,
): Promise<string[]> {
	const allFiles = await readdir(dataDir);
	const downloading = new Set(
		allFiles
			.filter((f) => f.endsWith('.aria2'))
			.map((f) => f.replace(/\.aria2$/, '')),
	);

	const candidates = allFiles
		.filter(
			(f) => f.includes(source) && f.endsWith('.zst') && !downloading.has(f),
		)
		.sort(); // oldest first — filenames contain ISO dates

	return candidates;
}

/**
 * Filter out files that have already been imported,
 * based on a set of previously imported filenames.
 */
export function filterNewFiles(
	files: string[],
	imported: Set<string>,
): string[] {
	return files.filter((f) => !imported.has(f));
}
