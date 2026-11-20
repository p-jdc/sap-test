<script lang="ts">
	import type { TestStatus } from '#lib/shared/types.js';

	let { history, max = 15 }: { history: { runId: string; status: TestStatus }[]; max?: number } =
		$props();
	const shown = $derived(history.slice(-max));
</script>

<span class="dots" aria-label="Run history, oldest to newest">
	{#each shown as h (h.runId)}
		<a href="/runs/{h.runId}" class="dot {h.status}" title="{h.runId}: {h.status}"></a>
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
