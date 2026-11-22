import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';

import { must } from '../../test/must.js';
import HistoryDots from './HistoryDots.svelte';

const history = Array.from({ length: 20 }, (_, i) => ({
	runId: `20261120-0000${String(i).padStart(2, '0')}-abcd`,
	status: i === 19 ? ('failed' as const) : ('passed' as const)
}));

test('shows the newest runs only, oldest first, each linking to its run', async () => {
	const { container } = await render(HistoryDots, { history, max: 5 });
	const dots = [...container.querySelectorAll('a.dot')];
	expect(dots).toHaveLength(5);
	expect(dots.at(-1)?.getAttribute('href')).toBe(`/runs/${must(history[19]).runId}`);
	expect(dots.at(-1)?.classList.contains('failed')).toBe(true);
	expect(must(dots[0]).classList.contains('passed')).toBe(true);
});
