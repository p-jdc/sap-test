<script lang="ts">
	import { goto } from '$app/navigation';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { homeHref, runHref, testsHref } from '#lib/client/links.js';
	import { view } from '#lib/client/view.svelte.js';
	import { duration, scopeLabel, when } from '#lib/shared/format.js';
	import { getOlderRuns, getRuns } from '#lib/remote/runs.remote.js';
	import type { RunMeta } from '#lib/shared/types.js';

	const runs = getRuns();

	// The list starts with the newest runs. Each "show older" adds the page after the last run
	// shown; `after` holds the run each added page starts behind.
	let after = $state<string[]>([]);
	const older = $derived(after.map((id) => getOlderRuns(id)));
	const shown = $derived(
		(runs.current?.runs.length ?? 0) + older.reduce((n, page) => n + (page.current?.length ?? 0), 0)
	);
	const last = $derived(older.at(-1)?.current?.at(-1) ?? runs.current?.runs.at(-1));
	const loading = $derived(older.some((page) => !page.current));

	function showOlder() {
		if (last) after.push(last.id);
	}
	function refresh() {
		after = [];
		void runs.refresh();
	}
</script>

{#snippet row(r: RunMeta)}
	<ui5-table-row interactive onclick={() => goto(runHref(r.id))} style="cursor: pointer">
		<ui5-table-cell><a href={runHref(r.id)}>{when(r.startedAt)}</a></ui5-table-cell>
		<ui5-table-cell><StatusTag status={r.status} /></ui5-table-cell>
		<ui5-table-cell>
			{r.stats.passed} passed · {r.stats.failed} failed · {r.stats.skipped} skipped
		</ui5-table-cell>
		<ui5-table-cell>
			{r.finishedAt ? duration(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : '…'}
		</ui5-table-cell>
		{#if view.technical}
			<ui5-table-cell class="mono">
				{r.files.length ? r.files.join(', ') : 'all tests'}{r.grep ? ` · grep ${r.grep}` : ''}
			</ui5-table-cell>
		{:else}
			<ui5-table-cell>{scopeLabel(r.files)}</ui5-table-cell>
		{/if}
	</ui5-table-row>
{/snippet}

<div class="page-head">
	<ui5-title level="H2">Results</ui5-title>
	<span class="spacer"></span>
	<ui5-button icon="refresh" design="Transparent" onclick={refresh} tooltip="Refresh"></ui5-button>
</div>

{#if !runs.current}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{:else if runs.current.runs.length === 0}
	<ui5-illustrated-message name="NoData" title-text="Nothing has run yet">
		<span slot="subtitle">
			Run tests from the <a href={homeHref()}>home page</a> or the
			<a href={testsHref()}>tests page</a>; every run is listed here afterwards.
		</span>
	</ui5-illustrated-message>
{:else}
	<ui5-table>
		<ui5-table-header-row slot="headerRow">
			<ui5-table-header-cell width="12rem">Started</ui5-table-header-cell>
			<ui5-table-header-cell width="8rem">Result</ui5-table-header-cell>
			<ui5-table-header-cell width="16rem">Tests</ui5-table-header-cell>
			<ui5-table-header-cell width="7rem">Duration</ui5-table-header-cell>
			<ui5-table-header-cell min-width="200px">What ran</ui5-table-header-cell>
		</ui5-table-header-row>
		{#each runs.current.runs as r (r.id)}
			{@render row(r)}
		{/each}
		{#each older as page, i (after[i])}
			{#each page.current ?? [] as r (r.id)}
				{@render row(r)}
			{/each}
		{/each}
	</ui5-table>
	{#if shown < runs.current.total}
		<div class="more">
			<span class="muted">Showing {shown} of {runs.current.total} results</span>
			<ui5-button onclick={showOlder} disabled={loading || undefined}>
				Show older results
			</ui5-button>
		</div>
	{/if}
{/if}

<style>
	.more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 1rem;
	}
</style>
