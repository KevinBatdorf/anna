/**
 * Generic streaming import engine for .zst data files.
 * Uses @bokuweb/zstd-wasm for in-process frame-by-frame decompression.
 * Parses the seekable zst seek table for exact frame boundaries.
 * Natural backpressure: one frame decompressed at a time, insert awaited
 * before the next frame is read.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { decompress, init as initZstd } from '@bokuweb/zstd-wasm';

const BATCH = 500;
/** Seekable zst footer magic: 0x8F92EAB1 (little-endian) */
const SEEKABLE_MAGIC = new Uint8Array([0xb1, 0xea, 0x92, 0x8f]);

let zstdReady = false;

export interface ImportConfig<T> {
	filePattern: string;
	parse: (line: string) => T | null;
	insert: (batch: T[]) => Promise<unknown>;
	skip?: number;
	onBatch?: (linesProcessed: number, count: number) => Promise<void>;
	limit?: number;
}

/** Read the seek table from the end of a .seekable.zst file.
 *  Returns an array of compressed frame sizes in order. */
async function readSeekTable(path: string): Promise<number[]> {
	const fh = await open(path, 'r');
	const fileSize = (await stat(path)).size;

	try {
		// Footer is last 9 bytes: [numFrames(4), descriptor(1), magic(4)]
		const footerBuf = Buffer.alloc(9);
		await fh.read(footerBuf, 0, 9, fileSize - 9);
		// Verify magic
		if (
			footerBuf[5] !== SEEKABLE_MAGIC[0] ||
			footerBuf[6] !== SEEKABLE_MAGIC[1] ||
			footerBuf[7] !== SEEKABLE_MAGIC[2] ||
			footerBuf[8] !== SEEKABLE_MAGIC[3]
		) {
			throw new Error('Not a seekable zst file (bad footer magic)');
		}

		const view = new DataView(
			footerBuf.buffer,
			footerBuf.byteOffset,
			footerBuf.byteLength,
		);
		const numFrames = view.getUint32(0, true);
		const descriptor = footerBuf[4];
		const hasChecksum = (descriptor & 0x80) !== 0;
		const entrySize = hasChecksum ? 12 : 8;

		// Seek table entries sit before the skippable frame footer.
		// Layout: [skippable_magic(4)][frame_size(4)][entries...][footer(9)]
		const tableSize = numFrames * entrySize;
		const tableStart = fileSize - 9 - tableSize;
		const tableBuf = Buffer.alloc(tableSize);
		await fh.read(tableBuf, 0, tableSize, tableStart);
		const tableView = new DataView(
			tableBuf.buffer,
			tableBuf.byteOffset,
			tableBuf.byteLength,
		);

		const frameSizes: number[] = [];
		for (let i = 0; i < numFrames; i++) {
			const compressedSize = tableView.getUint32(i * entrySize, true);
			frameSizes.push(compressedSize);
		}
		return frameSizes;
	} finally {
		await fh.close();
	}
}

/** Yields individual zstd frames from a .seekable.zst file using the seek table. */
async function* readFrames(
	path: string,
): AsyncGenerator<Uint8Array, void, void> {
	const frameSizes = await readSeekTable(path);
	// Use Node fs.read for exact byte reads (Bun.file().slice() returns wrong
	// sizes on Docker-mounted volumes)
	const fh = await open(path, 'r');
	let offset = 0;

	try {
		for (const size of frameSizes) {
			const buf = Buffer.alloc(size);
			const { bytesRead } = await fh.read(buf, 0, size, offset);
			yield new Uint8Array(buf.buffer, 0, bytesRead);
			offset += size;
		}
	} finally {
		await fh.close();
	}
}

export const streamImport = async <T>(
	dataDir: string,
	config: ImportConfig<T>,
) => {
	const { limit, skip = 0 } = config;

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

	const fileName = files[0];
	const filePath = `${dataDir}/${fileName}`;

	const decoder = new TextDecoder();
	let lineNum = 0;
	let count = 0;
	let batch: T[] = [];
	let leftover = '';
	let done = false;

	for await (const frame of readFrames(filePath)) {
		if (done) break;

		const decompressed = decompress(frame, {
			defaultHeapSize: 16 * 1024 * 1024,
		});
		const text = leftover + decoder.decode(decompressed);
		const lines = text.split('\n');
		leftover = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;
			lineNum++;
			if (lineNum <= skip) continue;

			const parsed = config.parse(line);
			if (!parsed) continue;
			batch.push(parsed);

			if (batch.length >= BATCH) {
				await config.insert(batch);
				count += batch.length;
				batch = [];
				if (config.onBatch) await config.onBatch(lineNum, count);
				if (limit && count >= limit) {
					done = true;
					break;
				}
			}
		}
	}

	// Process leftover partial line
	if (!done && leftover.trim()) {
		const parsed = config.parse(leftover);
		if (parsed) batch.push(parsed);
	}

	if (batch.length > 0 && (!limit || count < limit)) {
		await config.insert(batch);
		count += batch.length;
		if (config.onBatch) await config.onBatch(lineNum, count);
	}

	return { file: fileName, count };
};
