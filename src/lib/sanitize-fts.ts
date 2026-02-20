export function sanitizeFtsQuery(q: string): string {
	return q
		.replace(/['"(){}^+:*\\]/g, '')
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => term.replace(/^-+/, ''))
		.filter(Boolean)
		.filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t.toUpperCase()))
		.map((term) => `${term}*`)
		.join(' ');
}
