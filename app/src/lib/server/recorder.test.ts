import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Every case here is refused before the recorder would start a browser.
async function recorderWith(envFile: string) {
	const dir = mkdtempSync(join(tmpdir(), 'recorder-'));
	writeFileSync(join(dir, '.env'), envFile);
	vi.stubEnv('SAP_TESTS_DIR', dir);
	vi.resetModules();
	return { dir, recorder: await import('./recorder.js') };
}

const SAP = `SAP_URL=https://sap.example.com/fiori\nSAP_USERNAME=U\nSAP_PASSWORD=P\n`;

beforeEach(() => {
	vi.unstubAllEnvs();
	for (const name of ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'ARIBA_URL']) vi.stubEnv(name, '');
});

describe('startRecording refuses', () => {
	test('a start URL on another host when it would log in with the .env credentials', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const result = await recorder.startRecording({
			surface: 'fiori',
			name: 'Create order',
			url: 'https://evil.example.net/login'
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).toContain('same host as SAP_URL');
		expect(recorder.recorderState().status).toBe('idle');
		expect(existsSync(join(dir, 'tests'))).toBe(false);
	});

	test('a name without letters or digits', async () => {
		const { recorder } = await recorderWith(SAP);
		expect(await recorder.startRecording({ surface: 'fiori', name: ' ../ ' })).toEqual({
			ok: false,
			error: 'Give the flow a name.'
		});
	});

	test('missing credentials and a missing URL', async () => {
		const { recorder } = await recorderWith(`SAP_URL=https://sap.example.com\n`);
		const webgui = await recorder.startRecording({ surface: 'webgui', name: 'x' });
		expect(JSON.stringify(webgui)).toContain('SAP_USERNAME / SAP_PASSWORD missing');
		const ariba = await recorder.startRecording({ surface: 'ariba', name: 'x' });
		expect(JSON.stringify(ariba)).toContain('ARIBA_URL is not set');
	});
});

describe('withPluginImport', () => {
	test('points a recorded spec at sap-plugin, relative to its folder', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const recorded = `import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n  await page.getByRoleUI5('Button', { text: 'Save' }).click();\n});\n`;
		const spec = join(dir, 'tests', 'fiori', 'create-order.spec.ts');
		expect(recorder.withPluginImport(recorded, spec)).toBe(
			recorded.replace(`'@playwright/test'`, `'../../sap-plugin'`)
		);
	});
});
