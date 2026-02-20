const OLLAMA_URL = process.env.OLLAMA_URL || '';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

export function isOllamaEnabled(): boolean {
	return OLLAMA_URL.length > 0;
}

export function getEmbedModel(): string {
	return OLLAMA_EMBED_MODEL;
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
	if (!OLLAMA_URL) throw new Error('OLLAMA_URL not configured');

	const res = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts }),
		signal: AbortSignal.timeout(30_000),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Ollama embed failed (${res.status}): ${text}`);
	}

	const data: { embeddings: number[][] } = await res.json();
	return data.embeddings.map((e) => new Float32Array(e));
}

export async function embedSingle(text: string): Promise<Float32Array> {
	const [result] = await embed([text]);
	return result;
}
