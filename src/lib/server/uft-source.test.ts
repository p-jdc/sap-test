import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let data = '';

function source() {
	vi.resetModules();
	return import('./uft-source.js');
}

beforeEach(() => {
	vi.unstubAllEnvs();
	data = mkdtempSync(join(tmpdir(), 'uft-data-'));
	vi.stubEnv('TEST_APP_DATA_DIR', data);
});

describe('upload', () => {
	test('keeps the text files of UFT, appends parts, and reads them back', async () => {
		const { addToUpload, startUpload, uploadFiles } = await source();
		const id = startUpload();
		addToUpload(id, [
			{ path: 'T/Action1/Script.mts', text: 'Wait ' },
			{ path: 'T/Action1/Script.mts', text: '1' },
			{ path: 'T/Default.xls', text: 'binary' }
		]);
		expect(uploadFiles(id)).toEqual([{ path: 'T/Action1/Script.mts', text: 'Wait 1' }]);
	});

	test('refuses a path outside the upload and an unknown upload', async () => {
		const { addToUpload, startUpload } = await source();
		const id = startUpload();
		expect(() => {
			addToUpload(id, [{ path: '../../x.mts', text: '' }]);
		}).toThrow('Not a file inside the upload');
		expect(() => {
			addToUpload('00000000-0000-0000-0000-000000000000', []);
		}).toThrow('no longer there');
		expect(() => {
			addToUpload('../uploads', []);
		}).toThrow('no longer there');
	});

	test('removes uploads older than a day when a new one starts', async () => {
		const { startUpload } = await source();
		const old = startUpload(Date.now());
		startUpload(Date.now() + 25 * 60 * 60 * 1000);
		expect(existsSync(join(data, 'uft/uploads', old))).toBe(false);
	});
});

describe('gitUrlProblem', () => {
	test('takes HTTPS without credentials only', async () => {
		const { gitUrlProblem } = await source();
		expect(gitUrlProblem('https://git.example.com/org/uft.git')).toBeUndefined();
		expect(gitUrlProblem('http://git.example.com/org/uft.git')).toContain('https://');
		// oxlint-disable-next-line browser-security/no-password-in-url -- the address that must be refused
		expect(gitUrlProblem('https://me:token@git.example.com/org/uft.git')).toContain(
			'UFT_GIT_TOKEN'
		);
		expect(gitUrlProblem('git@github.com:org/uft.git')).toContain('HTTPS address');
		expect(gitUrlProblem('file:///tmp/repo')).toContain('https://');
	});
});

/** Runs git in a stand-in repository, without this computer's git settings. */
const run = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, {
		cwd,
		env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
	});

describe('fetchRepository', () => {
	test('checks out only the text files of the tests, and a new commit on the next read', async () => {
		const repo = mkdtempSync(join(tmpdir(), 'uft-repo-'));
		run(repo, 'init', '-q', '-b', 'main');
		run(repo, 'config', 'user.email', 'test@example.com');
		run(repo, 'config', 'user.name', 'Test');
		run(repo, 'config', 'uploadpack.allowFilter', 'true');
		mkdirSync(join(repo, 'Sales/VA01/Action1'), { recursive: true });
		writeFileSync(join(repo, 'Sales/VA01/Action1/Script.mts'), 'Wait 1');
		writeFileSync(join(repo, 'Sales/VA01/Action1/ObjectRepository.bdb'), 'binary');
		run(repo, 'add', '.');
		run(repo, 'commit', '-q', '-m', 'one');

		const { checkoutFiles, fetchRepository } = await source();
		expect(await checkoutFiles()).toBeUndefined();
		const first = await fetchRepository({ url: `file://${repo}` }, true);
		expect(first.branch).toBe('main');
		const read = await checkoutFiles();
		expect(read?.files).toEqual([{ path: 'Sales/VA01/Action1/Script.mts', text: 'Wait 1' }]);
		expect(read?.commit).toBe(first.commit);
		expect(existsSync(join(data, 'uft/git/Sales/VA01/Action1/ObjectRepository.bdb'))).toBe(false);

		writeFileSync(join(repo, 'Sales/VA01/Action1/Script.mts'), 'Wait 2');
		run(repo, 'commit', '-q', '-am', 'two');
		const second = await fetchRepository({ url: `file://${repo}`, branch: 'main' }, true);
		expect(second.commit).not.toBe(first.commit);
		expect((await checkoutFiles())?.files[0]?.text).toBe('Wait 2');
	});

	test('names what git says when the repository cannot be read', async () => {
		const { fetchRepository } = await source();
		await expect(fetchRepository({ url: `file://${join(data, 'missing')}` }, true)).rejects.toThrow(
			/^Git: /
		);
	});
});
