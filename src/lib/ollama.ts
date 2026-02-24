const OLLAMA_URL = process.env.OLLAMA_URL || '';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

export function isOllamaEnabled(): boolean {
	return OLLAMA_URL.length > 0;
}

export function getEmbedModel(): string {
	return OLLAMA_EMBED_MODEL;
}

async function tryEmbed(texts: string[]): Promise<Float32Array[]> {
	const res = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts }),
		signal: AbortSignal.timeout(30_000),
	});

	if (res.status === 400) {
		const body = await res.text();
		if (body.includes('context length')) {
			const maxLen = Math.max(...texts.map((t) => t.length));
			if (maxLen <= 1) throw new Error(`Ollama embed failed: ${body}`);
			const half = Math.floor(maxLen / 2);
			return tryEmbed(texts.map((t) => t.slice(0, half)));
		}
		throw new Error(`Ollama embed failed (400): ${body}`);
	}

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Ollama embed failed (${res.status}): ${body}`);
	}

	const data: { embeddings: number[][] } = await res.json();
	return data.embeddings.map((e) => new Float32Array(e));
}

export function embed(texts: string[]): Promise<Float32Array[]> {
	if (!OLLAMA_URL) throw new Error('OLLAMA_URL not configured');
	return tryEmbed(texts);
}

export async function embedSingle(text: string): Promise<Float32Array> {
	const [result] = await embed([text]);
	return result;
}
