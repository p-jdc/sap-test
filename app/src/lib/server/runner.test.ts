import { describe, expect, test } from 'vitest';
import { LIVE_REPORTER } from './paths.js';
import { runArgs } from './runner.js';

describe('runArgs', () => {
	const reporters = `--reporter=${LIVE_REPORTER},list,html`;

	test('runs the chosen tests unseen by default', () => {
		expect(runArgs({ grep: 'order' }, ['fiori/a.spec.ts:7'], '/runs/r1/results')).toEqual([
			'test',
			'tests/fiori/a.spec.ts:7',
			'--grep',
			'order',
			reporters,
			'--output',
			'/runs/r1/results'
		]);
	});

	test('shows the browser when asked', () => {
		expect(runArgs({ headed: true }, [], '/r')).toContain('--headed');
		expect(runArgs({ headed: false }, [], '/r')).not.toContain('--headed');
	});
});
