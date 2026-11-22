<script lang="ts">
	import type { MfsScenarioRun } from '#lib/shared/mfs.js';

	let { run }: { run: MfsScenarioRun } = $props();

	const STEP_ICON = {
		pending: 'circle-task',
		running: 'media-play',
		done: 'accept',
		failed: 'decline',
		skipped: 'less'
	} as const;
	const STEP_TEXT = {
		pending: 'Not started',
		running: 'Running',
		done: 'Done',
		failed: 'Failed',
		skipped: 'Skipped'
	} as const;

	const hus = $derived(Object.entries(run.hus));
	const paused = $derived(run.status === 'paused');
</script>

<ol class="steps">
	{#each run.steps as step, index (index)}
		<li class={step.status}>
			<ui5-icon
				name={step.status === 'running' && paused ? 'media-pause' : STEP_ICON[step.status]}
				accessible-name={step.status === 'running' && paused ? 'Paused' : STEP_TEXT[step.status]}
				show-tooltip
			></ui5-icon>
			<span>{step.title}</span>
			{#if step.detail}<span class="muted">{step.detail}</span>{/if}
		</li>
	{/each}
</ol>

{#if run.checks.length}
	<div class="checks">
		<strong>Expected results</strong>
		{#each run.checks as check, index (index)}
			<div class="check" class:failed={!check.ok}>
				<ui5-icon
					name={check.ok ? 'accept' : 'decline'}
					accessible-name={check.ok ? 'Met' : 'Not met'}
					show-tooltip
				></ui5-icon>
				<span>{check.title}</span>
				{#if check.detail}<span class="muted">{check.detail}</span>{/if}
			</div>
		{/each}
	</div>
{/if}

{#if hus.length}
	<p class="muted hus">
		HU numbers in this run: {hus.map(([name, number]) => `${name} = ${number}`).join(', ')}
	</p>
{/if}

<style>
	.steps {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.steps li,
	.check {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	ui5-icon {
		width: 1rem;
		height: 1rem;
		flex: none;
		align-self: center;
		color: var(--sapContent_IconColor);
	}
	.done ui5-icon,
	.check ui5-icon {
		color: var(--sapPositiveColor);
	}
	.running ui5-icon {
		color: var(--sapInformativeColor);
	}
	.failed ui5-icon,
	.check.failed ui5-icon {
		color: var(--sapNegativeColor);
	}
	.pending,
	.skipped {
		color: var(--sapContent_LabelColor);
	}
	.running {
		font-weight: bold;
	}
	.checks {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.hus {
		margin: 0.5rem 0 0;
	}
</style>
