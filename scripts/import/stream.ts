/**
 * Generic streaming import engine for a single .zst data file.
 * Expects exactly one matching file — errors if zero or multiple found.
 *
 * Uses @bokuweb/zstd-wasm to decompress individual zstd frames in-process.
 * The .seekable.zst files are concatenated frames, so we read the file
 * with Bun.file().stream(), find frame boundaries via the magic bytes
 * (0xFD2FB528), and decompress one frame at a time to keep memory low.
 */
import { readdir } from 'node:fs/promises';
import { decompress, init as initZstd } from '@bokuweb/zstd-wasm';

const BATCH = 500;
/** Zstd frame magic number: 0x28B52FFD (little-endian) */
const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);

const clean = (s: string | null): string | null =>
	s?.replaceAll('\x00', '') ?? null;

export { clean };

export const logDir =
	process.env.LOG_DIR || `${import.meta.dirname}/../../data`;

export const createLog = (name: string) => {
	const path = `${logDir}/${name}.log`;
	const fd = require('node:fs').openSync(path, 'a');
	return (msg: string) => {
		const line = `[${new Date().toISOString()}] ${msg}\n`;
		process.stdout.write(line);
		require('node:fs').writeSync(fd, line);
	};
};

let zstdReady = false;

export interface ImportConfig<T> {
	filePattern: string;
	log: (msg: string) => void;
	parse: (line: string) => T | null;
	insert: (batch: T[], resume: boolean) => Promise<unknown>;
	resume?: boolean;
	limit?: number;
}

/** Find the next zstd frame magic starting from `from` (exclusive of position 0 when from=0). */
const findNextFrame = (buf: Uint8Array, from: number): number => {
	for (let i = from; i <= buf.length - 4; i++) {
		if (
			buf[i] === ZSTD_MAGIC[0] &&
			buf[i + 1] === ZSTD_MAGIC[1] &&
			buf[i + 2] === ZSTD_MAGIC[2] &&
			buf[i + 3] === ZSTD_MAGIC[3]
		) {
			return i;
		}
	}
	return -1;
};

/**
 * Yields individual zstd frames from a .seekable.zst file by reading
 * it in chunks and splitting on frame magic bytes.
 */
async function* readFrames(
	path: string,
): AsyncGenerator<Uint8Array, void, void> {
	const reader = Bun.file(path).stream().getReader();
	let buf = new Uint8Array(0);

	const append = (chunk: Uint8Array) => {
		const next = new Uint8Array(buf.length + chunk.length);
		next.set(buf);
		next.set(chunk, buf.length);
		buf = next;
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		append(value);

		// Yield complete frames from the buffer
		while (true) {
			// Skip the skippable seek table frame at the end (magic 0x184D2A5E)
			if (
				buf.length >= 4 &&
				buf[0] === 0x5e &&
				buf[1] === 0x2a &&
				buf[2] === 0x4d &&
				buf[3] === 0x18
			) {
				buf = new Uint8Array(0);
				break;
			}

			// Find next frame boundary after the current frame start
			const nextStart = findNextFrame(buf, 4);
			if (nextStart === -1) break; // Need more data

			yield buf.slice(0, nextStart);
			buf = buf.slice(nextStart);
		}
	}

	// Yield remaining data as last frame (if it starts with magic)
	if (
		buf.length > 4 &&
		buf[0] === ZSTD_MAGIC[0] &&
		buf[1] === ZSTD_MAGIC[1] &&
		buf[2] === ZSTD_MAGIC[2] &&
		buf[3] === ZSTD_MAGIC[3]
	) {
		yield buf;
	}
}

export const streamImport = async <T>(
	dataDir: string,
	config: ImportConfig<T>,
) => {
	const { log, limit, resume = false } = config;

	if (!zstdReady) {
		await initZstd();
		zstdReady = true;
	}

	const allFiles = await readdir(dataDir);
	const files = allFiles.filter(
		(f) =>
			f.includes(config.filePattern) &&
			f.endsWith('.zst') &&
			!allFiles.includes(`${f}.aria2`),
	);

	if (files.length !== 1)
		throw new Error(
			`Expected 1 ${config.filePattern} file, found ${files.length}`,
		);

	const file = files[0];
	const filePath = `${dataDir}/${file}`;
	log(
		`Importing: ${file}${resume ? ' (resume — ON CONFLICT DO NOTHING)' : ' (full upsert)'}`,
	);

	const decoder = new TextDecoder();
	let count = 0;
	let errors = 0;
	let batch: T[] = [];
	let partial = ''; // Leftover partial line from previous frame
	let done = false;

	for await (const frame of readFrames(filePath)) {
		if (done) break;

		let text: string;
		try {
			const decompressed = decompress(frame);
			text = decoder.decode(decompressed);
		} catch (e) {
			log(`Frame decompress error: ${e instanceof Error ? e.message : e}`);
			continue;
		}

		// Prepend any leftover partial line from previous frame
		text = partial + text;
		const lines = text.split('\n');
		partial = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;
			let row: T | null;
			try {
				row = config.parse(line);
			} catch {
				errors++;
				continue;
			}
			if (!row) {
				errors++;
				continue;
			}
			batch.push(row);

			if (batch.length >= BATCH) {
				try {
					await config.insert(batch, resume);
					count += batch.length;
				} catch (e) {
					log(
						`Batch failed at ~${count}: ${e instanceof Error ? e.message : e}`,
					);
					errors += batch.length;
				}
				batch = [];
				if (limit && count >= limit) {
					log(`Limit reached (${limit.toLocaleString()})`);
					done = true;
					break;
				}
				await Bun.sleep(10);
				if (count % 10_000 === 0 && count > 0)
					log(`${count.toLocaleString()} rows (${errors} errors)`);
			}
		}
	}

	// Process last partial line
	if (!done && partial.trim()) {
		let row: T | null;
		try {
			row = config.parse(partial);
		} catch {
			row = null;
			errors++;
		}
		if (row) batch.push(row);
	}

	if (batch.length > 0 && (!limit || count < limit)) {
		try {
			await config.insert(batch, resume);
			count += batch.length;
		} catch (e) {
			log(`Final batch failed: ${e instanceof Error ? e.message : e}`);
			errors += batch.length;
		}
	}

	log(`Done: ${count.toLocaleString()} rows (${errors} errors)`);
};
