<script lang="ts">
	import type { IdocSegment } from '#lib/shared/idoc.js';

	let { segments }: { segments: IdocSegment[] } = $props();
</script>

<!-- The segments as SAP's IDoc display (WE02) shows them: a tree, each segment with its filled fields. -->
{#snippet tree(list: IdocSegment[])}
	<ul>
		<!-- Keyed by position: segments have no id and names repeat (two E1EDKA1), and the list is only
		     shown, never reordered or edited. -->
		{#each list as segment, i (i)}
			<li>
				<span class="segment mono">{segment.name}</span>
				<span class="fields mono">
					{#each Object.entries(segment.fields) as [name, value] (name)}
						<span><span class="muted">{name}</span> {value}</span>
					{/each}
				</span>
				{#if segment.children.length}
					{@render tree(segment.children)}
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

{#if segments.length}
	{@render tree(segments)}
{:else}
	<span class="muted">No segments.</span>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding-left: 1.25rem;
		border-left: 1px solid var(--sapList_BorderColor);
	}
	li {
		padding: 0.15rem 0;
	}
	.segment {
		font-weight: bold;
		margin-right: 0.5rem;
	}
	.fields {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0 0.75rem;
	}
</style>
