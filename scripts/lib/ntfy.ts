const NTFY_URL = process.env.NTFY_URL || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';

export async function notify(
	topic: string,
	title: string,
	message: string,
	tags = '',
	priority?: string,
) {
	if (!NTFY_URL) return;

	const headers: Record<string, string> = { Title: title };
	if (tags) headers.Tags = tags;
	if (priority) headers.Priority = priority;
	if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;

	try {
		await fetch(`${NTFY_URL}/${topic}`, {
			method: 'POST',
			headers,
			body: message,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`  ntfy error (${topic}): ${msg}`);
	}
}
