/**
 * StepNode renders inside a real SvelteFlow (Handles need its context), so this also pins the
 * @xyflow/svelte custom-node contract: a breaking change there empties every flow without an error.
 */
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';

import type { FlowStep } from '#lib/shared/types.js';
import Harness from './StepNodeHarness.svelte';

const step: FlowStep = {
	id: 's1',
	line: 12,
	endLine: 12,
	kind: 'action',
	action: 'fill',
	locator: { kind: 'ui5', display: `input("Sold-To Party")`, helper: 'input' },
	value: '1000',
	code: '',
	issues: []
};

test('shows action, locator kind, value and line', async () => {
	const { container } = await render(Harness, { data: { step } });
	const node = () => container.querySelector('.svelte-flow__node .node');
	await expect.poll(node).not.toBeNull();
	const text = node()!.textContent ?? '';
	expect(text).toContain('fill');
	expect(text).toContain('UI5');
	expect(text).toContain('input("Sold-To Party")');
	expect(text).toContain('“1000”');
	expect(text).toContain('line 12');
});

test('reflects the run overlay: failed status and duration', async () => {
	const { container } = await render(Harness, {
		data: { step, overlay: { status: 'failed', duration: 2000, calls: [] } }
	});
	const node = () => container.querySelector('.svelte-flow__node .node');
	await expect.poll(node).not.toBeNull();
	expect(node()!.classList.contains('failed')).toBe(true);
	expect(node()!.textContent).toContain('2.0 s');
});

test('marks rule findings with the worst severity', async () => {
	const withIssues: FlowStep = {
		...step,
		issues: [
			{ rule: 'avoid-nth', severity: 'info', message: 'nth', line: 12 },
			{ rule: 'no-css-xpath', severity: 'error', message: 'css', line: 12 }
		]
	};
	const { container } = await render(Harness, { data: { step: withIssues } });
	await expect.poll(() => container.querySelector('.svelte-flow__node .issue')).not.toBeNull();
	expect(container.querySelector('.svelte-flow__node .issue')?.classList.contains('error')).toBe(
		true
	);
});
