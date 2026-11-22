<script lang="ts">
	import { runHref } from '#lib/client/links.js';
	import { statusLabel } from '#lib/shared/format.js';
	import { HISTORY_SHOWN, type TestStatus } from '#lib/shared/types.js';

	let {
		history,
		max = HISTORY_SHOWN
	}: { history: { runId: string; status: TestStatus }[]; max?: number } = $props();
	const shown = $derived(history.slice(-max));
</script>

<span class="dots" aria-label="Run history, oldest to newest">
	{#each shown as h (h.runId)}
		<a
			href={runHref(h.runId)}
			class="dot {h.status}"
			title="{statusLabel(h.status)} – open this run"
			aria-label="Run {h.runId}: {statusLabel(h.status)}"
		></a>
	{/each}
</span>

<style>
	.dots {
		display: inline-flex;
		gap: 3px;
		align-items: center;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--sapNeutralColor);
	}
	.passed {
		background: var(--sapPositiveColor);
	}
	.failed,
	.timedOut {
		background: var(--sapNegativeColor);
	}
	.interrupted {
		background: var(--sapCriticalColor);
	}
</style>
