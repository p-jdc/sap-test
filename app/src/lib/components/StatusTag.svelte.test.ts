/**
 * StatusTag is the only place a test/run status turns into a UI5 Tag design, and a wrong mapping
 * (a failed run shown neutral) would read as "nothing to look at" on every page.
 */
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';

import StatusTag from './StatusTag.svelte';

test.each([
	['passed', 'Positive'],
	['failed', 'Negative'],
	['timedOut', 'Negative'],
	['interrupted', 'Critical'],
	['running', 'Information'],
	['skipped', 'Neutral']
])('%s renders as a %s tag', async (status, design) => {
	const { container } = await render(StatusTag, { status });
	const tag = container.querySelector('ui5-tag');
	expect(tag?.getAttribute('design')).toBe(design);
	expect(tag?.textContent?.trim()).toBe(status);
});

test('a missing status reads "not run" without a state icon', async () => {
	const { container } = await render(StatusTag, { status: undefined });
	const tag = container.querySelector('ui5-tag');
	expect(tag?.textContent?.trim()).toBe('not run');
	expect(tag?.hasAttribute('hide-state-icon')).toBe(true);
});

test('a label overrides the status text', async () => {
	const { container } = await render(StatusTag, {
		status: 'passed',
		label: 'Playwright-SAP 1.1.6'
	});
	expect(container.querySelector('ui5-tag')?.textContent?.trim()).toBe('Playwright-SAP 1.1.6');
});
