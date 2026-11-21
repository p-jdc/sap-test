<script lang="ts">
	import { view } from '#lib/client/view.svelte.js';
	import { getChecklist, toggleChecklistItem } from '#lib/remote/checklist.remote.js';

	const list = getChecklist();
	const total = $derived(list.current?.phases.reduce((n, p) => n + p.items.length, 0) ?? 0);
	const doneCount = $derived(Object.values(list.current?.checked ?? {}).filter(Boolean).length);
</script>

<div class="page-head">
	<ui5-title level="H2">Rollout checklist</ui5-title>
	<span class="muted">{view.technical ? 'Guide §12 · ' : ''}{doneCount} of {total} done</span>
</div>

<p class="muted intro">
	The steps for introducing automated SAP testing in your team, phase by phase. Tick a step when it
	is done; the list is saved for everyone who uses this app.
</p>

{#if list.current}
	<div class="grid">
		{#each list.current.phases as phase (phase.phase)}
			{@const n = phase.items.filter((i) => list.current?.checked[i.id]).length}
			<ui5-card>
				<ui5-card-header
					slot="header"
					title-text={phase.phase}
					subtitle-text="{n} / {phase.items.length}"
				></ui5-card-header>
				<div class="card-body">
					{#each phase.items as item (item.id)}
						<ui5-checkbox
							text={item.text}
							wrapping-type="Normal"
							checked={list.current.checked[item.id] || undefined}
							onchange={(e: Event) =>
								toggleChecklistItem({
									id: item.id,
									checked: (e.target as HTMLInputElement).checked
								})}
						></ui5-checkbox>
					{/each}
				</div>
			</ui5-card>
		{/each}
	</div>
{:else}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{/if}

<style>
	.intro {
		margin: 0 0 1rem;
		max-width: 50rem;
	}
</style>
