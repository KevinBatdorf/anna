import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('plugin validation', () => {
	it('passes claude plugin validate', () => {
		const result = execSync('bun run validate-plugin', {
			encoding: 'utf-8',
			cwd: ROOT,
			timeout: 30000,
		});
		expect(result).toContain('Validation passed');
	});
});
