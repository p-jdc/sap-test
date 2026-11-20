<script lang="ts">
	import { goto } from '$app/navigation';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { runAndOpen } from '#lib/client/run-actions.js';
	import { SURFACE_LABEL } from '#lib/shared/format.js';
	import { getSpecs } from '#lib/remote/specs.remote.js';
	import { getRuns, getStability } from '#lib/remote/runs.remote.js';
	import type { Surface } from '#lib/shared/types.js';

	const specs = getSpecs();
	const stab = getStability();
	const runs = getRuns();

	let filter = $state<Surface | 'all'>('all');
	let error = $state<string | null>(null);

	const FILTERS: (Surface | 'all')[] = ['all', 'fiori', 'webgui', 'ariba', 'demo', 'other'];
	const files = $derived(
		(specs.current ?? []).filter((f) => filter === 'all' || f.surface === filter)
	);
	const lastStatus = $derived(
		new Map((stab.current?.rows ?? []).map((r) => [r.key, r.lastStatus]))
	);
	const busy = $derived(!!runs.current?.active);

	function onFilter(e: CustomEvent) {
		filter = ((e.detail.selectedItems?.[0] as HTMLElement | undefined)?.dataset.value ??
			'all') as typeof filter;
	}

	async function run(files: string[]) {
		error = await runAndOpen({ files });
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Tests & Flows</ui5-title>
	<ui5-segmented-button onselection-change={onFilter}>
		{#each FILTERS as f (f)}
			<ui5-segmented-button-item data-value={f} selected={filter === f || undefined}>
				{f === 'all' ? 'All' : SURFACE_LABEL[f]}
			</ui5-segmented-button-item>
		{/each}
	</ui5-segmented-button>
	<span class="spacer"></span>
	<ui5-button
		icon="refresh"
		design="Transparent"
		onclick={() => specs.refresh()}
		tooltip="Re-scan tests"
	></ui5-button>
</div>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if specs.current && files.length === 0}
	<ui5-illustrated-message name="NoData" title-text="No tests here">
		<span slot="subtitle">Record a flow or add a spec under sap-tests/tests.</span>
	</ui5-illustrated-message>
{/if}

{#each files as file (file.file)}
	<ui5-panel header-text={file.file} class="file-panel">
		<div slot="header" class="file-head">
			<ui5-title level="H5">{file.file}</ui5-title>
			<ui5-tag hide-state-icon>{SURFACE_LABEL[file.surface]}</ui5-tag>
			<span class="spacer"></span>
			<ui5-button
				icon="play"
				design="Transparent"
				disabled={busy || undefined}
				onclick={(e: Event) => {
					e.stopPropagation();
					run([file.file]);
				}}
			>
				Run file
			</ui5-button>
		</div>
		{#if file.parseError}
			<ui5-message-strip design="Negative" hide-close-button>
				Could not parse: {file.parseError}
			</ui5-message-strip>
		{/if}
		{#each file.issues as issue (issue.rule + issue.line)}
			<ui5-message-strip design="Critical" hide-close-button>
				Line {issue.line}: {issue.message}
			</ui5-message-strip>
		{/each}
		<ui5-table>
			<ui5-table-header-row slot="headerRow">
				<ui5-table-header-cell min-width="260px">Test</ui5-table-header-cell>
				<ui5-table-header-cell>Steps</ui5-table-header-cell>
				<ui5-table-header-cell min-width="180px">Rule findings</ui5-table-header-cell>
				<ui5-table-header-cell>Last result</ui5-table-header-cell>
				<ui5-table-header-cell min-width="200px"></ui5-table-header-cell>
			</ui5-table-header-row>
			{#each file.tests as test (test.key)}
				{@const errors = test.issues.filter((i) => i.severity === 'error').length}
				{@const warnings = test.issues.filter((i) => i.severity === 'warning').length}
				{@const infos = test.issues.filter((i) => i.severity === 'info').length}
				<ui5-table-row>
					<ui5-table-cell>
						<div>
							<a href="/flow?key={encodeURIComponent(test.key)}">{test.title}</a>
							<div class="muted">line {test.line}</div>
						</div>
					</ui5-table-cell>
					<ui5-table-cell>{test.steps.length}</ui5-table-cell>
					<ui5-table-cell>
						<div class="row">
							{#if errors}<ui5-tag design="Negative">{errors} error</ui5-tag>{/if}
							{#if warnings}<ui5-tag design="Critical">{warnings} warning</ui5-tag>{/if}
							{#if infos}<ui5-tag design="Information">{infos} hint</ui5-tag>{/if}
							{#if !test.issues.length}<ui5-tag design="Positive">clean</ui5-tag>{/if}
						</div>
					</ui5-table-cell>
					<ui5-table-cell><StatusTag status={lastStatus.get(test.key)} /></ui5-table-cell>
					<ui5-table-cell>
						<div class="row">
							<ui5-button
								icon="process"
								onclick={() => goto(`/flow?key=${encodeURIComponent(test.key)}`)}
							>
								Flow
							</ui5-button>
							<ui5-button
								icon="play"
								disabled={busy || undefined}
								onclick={() => run([`${file.file}:${test.line}`])}
							>
								Run
							</ui5-button>
						</div>
					</ui5-table-cell>
				</ui5-table-row>
			{/each}
		</ui5-table>
	</ui5-panel>
{/each}

<style>
	.file-panel {
		margin-bottom: 0.75rem;
	}
	.file-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
	}
	.spacer {
		flex: 1;
	}
</style>
