import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, test } from 'vitest';
import { masker } from './healer-mask.js';

const SECRET = 'P!ss w0rd';

describe('masker', () => {
	const { text } = masker([SECRET]);

	test.each([
		['as it is', `typed ${SECRET} into the field`],
		['as a URL sends it', `sap-password=${encodeURIComponent(SECRET)}`],
		['as a form sends it', 'sap-password=P%21ss+w0rd']
	])('masks the password %s', (_how, value) => {
		expect(text(value)).not.toMatch(/P!ss|P%21ss/);
	});

	test('masks login headers and SAP session cookies, and leaves the rest', () => {
		const out = text(
			'cookie: MYSAPSSO2=abc; x=1\nAuthorization: Basic dXNlcjpwYXNz\ncontent-type: text/html\ndocument.cookie = "SAP_SESSIONID_S4H_100=xyz"'
		);
		expect(out).toBe(
			'cookie: ***\nAuthorization: ***\ncontent-type: text/html\ndocument.cookie = "SAP_SESSIONID_S4H_100=***"'
		);
	});

	test('masks every cookie of a Set-Cookie header that Playwright prints on several lines', () => {
		expect(
			text('set-cookie: a=1; Path=/\nIDP_J_COOKIE=secret; Path=/\n\ncontent-length: 12\nbody')
		).toBe('set-cookie: ***\n***\n\ncontent-length: 12\nbody');
	});
});

describe('the mask in front of the MCP server', () => {
	test('masks every answer, also an error result, and keeps the password from the server', async () => {
		const folder = mkdtempSync(join(tmpdir(), 'healer-mask-'));
		// A stand-in server: answers each request with an error result that holds the password,
		// and tells whether it got HEALER_MASK.
		const server = `
			const rl = require('node:readline').createInterface({ input: process.stdin });
			rl.on('line', (l) => {
				const { id } = JSON.parse(l);
				const text = 'Error: typed ${SECRET}; got mask: ' + (process.env.HEALER_MASK !== undefined) + '; in ' + process.cwd();
				console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } }));
			});`;
		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, 'healer-mask.ts'), process.execPath, '-e', server],
			{ env: { ...process.env, HEALER_MASK: JSON.stringify([SECRET]), HEALER_CWD: folder } }
		);
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' })}\n`);
		const [answer] = await new Promise<string[]>((resolve) => {
			createInterface({ input: child.stdout }).once('line', (l) => {
				resolve([l]);
			});
		});
		child.kill();
		expect(answer).toContain(`typed ***; got mask: false; in ${realpathSync(folder)}`);
		expect(answer).not.toContain('P!ss');
	});
});
