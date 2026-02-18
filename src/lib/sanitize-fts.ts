export function sanitizeFtsQuery(q: string): string {
	return q
		.replace(/['"]/g, '')
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term}"`)
		.join(' ');
}
