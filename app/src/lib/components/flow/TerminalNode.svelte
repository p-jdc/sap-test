<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { TerminalNodeData } from './types';

	let { data, id }: NodeProps & { data: TerminalNodeData } = $props();
</script>

{#if id !== 'start'}<Handle type="target" position={Position.Top} />{/if}
<div class="terminal {data.status ?? ''}">
	<strong>{data.label}</strong>
	{#if data.sub}<span>{data.sub}</span>{/if}
</div>
{#if id === 'start'}<Handle type="source" position={Position.Bottom} />{/if}

<style>
	.terminal {
		width: 300px;
		box-sizing: border-box;
		text-align: center;
		padding: 0.5rem;
		border-radius: 999px;
		background: #1d2d3e;
		color: #fff;
		display: flex;
		flex-direction: column;
		font-size: 0.8125rem;
	}
	span {
		font-size: 0.6875rem;
		opacity: 0.8;
	}
	.passed {
		background: var(--sapPositiveColor);
	}
	.failed,
	.timedOut {
		background: var(--sapNegativeColor);
	}
	.skipped,
	.interrupted {
		background: var(--sapCriticalColor);
	}
</style>
