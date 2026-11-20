<script lang="ts">
	import { goto } from '$app/navigation';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { duration, when } from '#lib/shared/format.js';
	import { getRuns } from '#lib/remote/runs.remote.js';

	const runs = getRuns();
</script>

<div class="page-head">
	<ui5-title level="H2">Runs</ui5-title>
	<span class="spacer"></span>
	<ui5-button icon="refresh" design="Transparent" onclick={() => runs.refresh()} tooltip="Refresh"
	></ui5-button>
</div>

{#if runs.current && runs.current.runs.length === 0}
	<ui5-illustrated-message name="NoData" title-text="No runs yet">
		<span slot="subtitle">
			Start one from the <a href="/">dashboard</a> or the <a href="/tests">tests page</a>.
		</span>
	</ui5-illustrated-message>
{:else if runs.current}
	<ui5-table>
		<ui5-table-header-row slot="headerRow">
			<ui5-table-header-cell min-width="180px">Started</ui5-table-header-cell>
			<ui5-table-header-cell>Status</ui5-table-header-cell>
			<ui5-table-header-cell min-width="240px">Result</ui5-table-header-cell>
			<ui5-table-header-cell>Duration</ui5-table-header-cell>
			<ui5-table-header-cell min-width="200px">Scope</ui5-table-header-cell>
		</ui5-table-header-row>
		{#each runs.current.runs as r (r.id)}
			<ui5-table-row interactive onclick={() => goto(`/runs/${r.id}`)} style="cursor: pointer">
				<ui5-table-cell><a href="/runs/{r.id}">{when(r.startedAt)}</a></ui5-table-cell>
				<ui5-table-cell><StatusTag status={r.status} /></ui5-table-cell>
				<ui5-table-cell>
					{r.stats.passed} passed · {r.stats.failed} failed · {r.stats.skipped} skipped
				</ui5-table-cell>
				<ui5-table-cell>
					{r.finishedAt ? duration(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : '…'}
				</ui5-table-cell>
				<ui5-table-cell class="mono">
					{r.files.length ? r.files.join(', ') : 'all tests'}{r.grep ? ` · grep ${r.grep}` : ''}
				</ui5-table-cell>
			</ui5-table-row>
		{/each}
	</ui5-table>
{/if}
