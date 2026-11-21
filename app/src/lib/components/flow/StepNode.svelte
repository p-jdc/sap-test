<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { view } from '#lib/client/view.svelte.js';
	import { duration, LOCATOR_LABEL, locatorColor } from '#lib/shared/format.js';
	import { describeStep } from '#lib/shared/step-text.js';
	import type { StepNodeData } from './types';

	let { data, selected }: NodeProps & { data: StepNodeData } = $props();

	const ICON: Record<string, string> = {
		navigate: 'journey-arrive',
		login: 'locked',
		action: 'navigation-right-arrow',
		assert: 'validate',
		wait: 'history',
		helper: 'syntax',
		group: 'process',
		other: 'document'
	};
	const step = $derived(data.step);
	const status = $derived(data.overlay?.status ?? 'idle');
	const worst = $derived(
		step.issues.some((i) => i.severity === 'error')
			? 'error'
			: step.issues.some((i) => i.severity === 'warning')
				? 'warning'
				: undefined
	);
</script>

<Handle type="target" position={Position.Top} />
<div class="node {status} {step.kind}" class:selected class:hook={step.hook}>
	<div class="top">
		<ui5-icon name={ICON[step.kind] ?? 'document'} class="kind"></ui5-icon>
		{#if view.technical}
			<span class="action">{step.kind === 'group' ? step.value : step.action}</span>
		{:else}
			<span class="action plain" title={describeStep(step)}>{describeStep(step)}</span>
		{/if}
		{#if step.locator && view.technical}
			<ui5-tag color-scheme={locatorColor(step.locator.kind)} hide-state-icon>
				{LOCATOR_LABEL[step.locator.kind]}
			</ui5-tag>
		{/if}
		{#if worst}
			<ui5-icon
				name={worst === 'error' ? 'error' : 'warning'}
				class="issue {worst}"
				title={step.issues.map((i) => i.message).join('\n')}
			></ui5-icon>
		{/if}
	</div>
	{#if view.technical}
		{#if step.locator}
			<div class="target mono" title={step.locator.display}>{step.locator.display}</div>
		{/if}
		{#if step.value !== undefined && step.kind !== 'group'}
			<div class="value" title={step.value}>“{step.value}”</div>
		{/if}
	{/if}
	<div class="meta">
		{#if view.technical}
			<span>{step.hook ? 'beforeEach · ' : ''}line {step.line}</span>
		{:else}
			<span>{step.hook ? 'Before every test' : ''}</span>
		{/if}
		{#if data.overlay && data.overlay.status !== 'pending' && data.overlay.status !== 'skipped'}
			<span>
				{status === 'running'
					? 'running…'
					: view.technical
						? duration(data.overlay.duration)
						: `${status === 'failed' ? 'Failed' : 'Done'} · ${duration(data.overlay.duration)}`}
			</span>
		{:else if data.overlay?.status === 'skipped'}
			<span>not reached</span>
		{/if}
	</div>
</div>
<Handle type="source" position={Position.Bottom} />

<style>
	.node {
		width: 300px;
		box-sizing: border-box;
		background: var(--sapTile_Background, #fff);
		border: 1px solid var(--sapTile_BorderColor, #d9d9d9);
		border-left: 6px solid var(--sapNeutralBorderColor, #788fa6);
		border-radius: 0.5rem;
		padding: 0.5rem 0.625rem;
		font-size: 0.8125rem;
		box-shadow: var(--sapContent_Shadow0);
		transition:
			border-color 0.2s,
			box-shadow 0.2s;
	}
	.node.selected {
		box-shadow: 0 0 0 2px var(--sapSelectedColor, #0064d9);
	}
	.node.hook {
		border-style: dashed;
		border-left-style: solid;
	}
	.node.group {
		background: var(--sapList_HeaderBackground);
		font-weight: 600;
	}
	.passed {
		border-left-color: var(--sapPositiveColor);
	}
	.failed {
		border-left-color: var(--sapNegativeColor);
		background: var(--sapErrorBackground);
	}
	.running {
		border-left-color: var(--sapInformativeColor);
		animation: pulse 1s ease-in-out infinite;
	}
	.skipped {
		opacity: 0.55;
	}
	@keyframes pulse {
		50% {
			box-shadow: 0 0 0 4px color-mix(in srgb, var(--sapInformativeColor) 35%, transparent);
		}
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.action {
		font-weight: 600;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The sentence may take two lines; the technical node keeps one line per fact. */
	.action.plain {
		white-space: normal;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		line-height: 1.3;
	}
	.top:has(.plain) {
		align-items: flex-start;
	}
	.kind {
		flex: none;
		width: 1rem;
		height: 1rem;
		color: var(--sapContent_IconColor);
	}
	.issue {
		width: 1rem;
		height: 1rem;
	}
	.issue.error {
		color: var(--sapNegativeColor);
	}
	.issue.warning {
		color: var(--sapCriticalColor);
	}
	.target,
	.value {
		margin-top: 0.25rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.value {
		color: var(--sapContent_LabelColor);
	}
	.mono {
		font-family: var(--sapFontFamilyMono, ui-monospace, monospace);
		font-size: 0.75rem;
	}
	.meta {
		display: flex;
		justify-content: space-between;
		margin-top: 0.25rem;
		color: var(--sapContent_LabelColor);
		font-size: 0.6875rem;
	}
</style>
