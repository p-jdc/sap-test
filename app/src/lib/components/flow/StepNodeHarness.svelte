<script lang="ts">
	import { SvelteFlow, type Node } from '@xyflow/svelte';
	import StepNode from './StepNode.svelte';
	import type { StepNodeData } from './types.js';

	let { data }: { data: StepNodeData } = $props();
	let nodes = $state.raw<Node[]>([]);
	$effect(() => {
		nodes = [{ id: 'n', type: 'step', position: { x: 0, y: 0 }, data }];
	});
	let edges = $state.raw([]);
</script>

<div style="width: 600px; height: 300px">
	<SvelteFlow bind:nodes bind:edges nodeTypes={{ step: StepNode }} />
</div>
