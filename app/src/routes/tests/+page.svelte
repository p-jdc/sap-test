<script lang="ts">
	import { goto } from '$app/navigation';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { flowHref, recorderHref } from '#lib/client/links.js';
	import { runAndOpen } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { SURFACE_LABEL, specName } from '#lib/shared/format.js';
	import { getSpecs, getSystems } from '#lib/remote/specs.remote.js';
	import { getRuns, getStability } from '#lib/remote/runs.remote.js';
	import type { SpecFile, Surface } from '#lib/shared/types.js';

	const specs = getSpecs();
	const systems = getSystems();
	const stab = getStability();
	const runs = getRuns();

	const ALL = 'all';
	/**
	 * Tests that start signed in to no system of sap-tests/systems.json are grouped by what they
	 * drive (the Fiori demo kit, API, demo, the plugin's own tests).
	 */
	const SURFACES: Surface[] = ['fiori', 'webgui', 'api', 'demo', 'other'];
	const surfaceGroup = (surface: Surface) => `surface:${surface}`;

	let filter = $state(ALL);
	let error = $state<string | null>(null);

	const groupOf = (f: SpecFile) => f.system ?? surfaceGroup(f.surface);
	// The systems in the order of systems.json, then the other tests.
	const groups = $derived([
		...new Set([
			...(systems.current ?? []).map((s) => s.id),
			...(specs.current ?? []).flatMap((f) => (f.system ? [f.system] : [])),
			...SURFACES.map((s) => surfaceGroup(s))
		])
	]);
	const title = (group: string) => {
		const surface = SURFACES.find((s) => surfaceGroup(s) === group);
		if (surface) return SURFACE_LABEL[surface];
		return systems.current?.find((s) => s.id === group)?.title ?? group;
	};
	const counts = $derived(
		(specs.current ?? []).reduce((acc, f) => {
			acc.set(groupOf(f), (acc.get(groupOf(f)) ?? 0) + f.tests.length);
			return acc;
		}, new Map<string, number>())
	);
	const total = $derived([...counts.values()].reduce((a, b) => a + b, 0));
	// Only groups that have tests get a filter; the selected one stays even when it empties.
	const filters = $derived([ALL, ...groups.filter((g) => counts.get(g) || g === filter)]);
	const files = $derived(
		(specs.current ?? []).filter((f) => filter === ALL || groupOf(f) === filter)
	);
	/** Fiori, WebGUI, API and demo say what a test drives; anything else, which system it is for. */
	const tag = (f: SpecFile) => {
		if (f.surface === 'other') return f.system ? title(f.system) : 'Other';
		return SURFACE_LABEL[f.surface];
	};
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const lastStatus = $derived(
		new Map((stab.current?.rows ?? []).map((r) => [r.key, r.lastStatus]))
	);
	const busy = $derived(!!runs.current?.active);

	function onFilter(e: CustomEvent<{ selectedItems: HTMLElement[] }>) {
		const value = e.detail.selectedItems[0]?.dataset.value;
		filter = filters.find((f) => f === value) ?? ALL;
	}

	async function run(specFiles: string[]) {
		error = await runAndOpen({ files: specFiles });
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Tests</ui5-title>
	{#if filters.length > 2}
		<ui5-segmented-button onselection-change={onFilter} accessible-name="Filter by system">
			{#each filters as f (f)}
				<ui5-segmented-button-item data-value={f} selected={filter === f || undefined}>
					{f === ALL ? 'All' : title(f)} ({f === ALL ? total : (counts.get(f) ?? 0)})
				</ui5-segmented-button-item>
			{/each}
		</ui5-segmented-button>
	{/if}
	<span class="spacer"></span>
	<ui5-button
		icon="refresh"
		design="Transparent"
		onclick={() => specs.refresh()}
		tooltip="Look for new tests"
	></ui5-button>
</div>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if !specs.current}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{:else if files.length === 0}
	<ui5-illustrated-message name="NoData" title-text="No tests here">
		<span slot="subtitle">
			<a href={recorderHref()}>Record a test</a> to get started{view.technical
				? ', or add a spec under sap-tests/tests'
				: ''}.
		</span>
	</ui5-illustrated-message>
{/if}

{#each files as file (file.file)}
	{@const name = view.technical ? file.file : specName(file.file)}
	<ui5-panel header-text={name} class="file-panel">
		<div slot="header" class="file-head">
			<ui5-title level="H5">{name}</ui5-title>
			<ui5-tag hide-state-icon>{tag(file)}</ui5-tag>
			<span class="spacer"></span>
			<ui5-button
				icon="play"
				design="Transparent"
				disabled={busy || undefined}
				onclick={(e: Event) => {
					e.stopPropagation();
					void run([file.file]);
				}}
			>
				Run {file.tests.length === 1 ? 'this test' : `these ${file.tests.length} tests`}
			</ui5-button>
		</div>
		{#if file.parseError}
			<ui5-message-strip design="Negative" hide-close-button>
				This test could not be read, so it is not listed. Someone who writes the tests needs to fix
				it{view.technical ? `: ${file.parseError}` : '.'}
			</ui5-message-strip>
		{/if}
		{#each file.issues as issue (issue.rule + issue.line)}
			<ui5-message-strip design="Critical" hide-close-button>
				{view.technical ? `Line ${issue.line}: ` : ''}{issue.message}
			</ui5-message-strip>
		{/each}
		<ui5-table overflow-mode="Popin">
			<ui5-table-header-row slot="headerRow">
				<!-- Fixed widths for the short columns, so the title gets the rest and every file's table lines up. -->
				<ui5-table-header-cell min-width="260px">Test</ui5-table-header-cell>
				<ui5-table-header-cell width="5rem">Steps</ui5-table-header-cell>
				<ui5-table-header-cell width="13rem">Quality check</ui5-table-header-cell>
				<ui5-table-header-cell width="8rem">Last result</ui5-table-header-cell>
				<ui5-table-header-cell width="15rem">Actions</ui5-table-header-cell>
			</ui5-table-header-row>
			{#each file.tests as test, i (test.key + i)}
				{@const errors = test.issues.filter((i) => i.severity === 'error').length}
				{@const warnings = test.issues.filter((i) => i.severity === 'warning').length}
				{@const infos = test.issues.filter((i) => i.severity === 'info').length}
				<ui5-table-row>
					<ui5-table-cell>
						<div>
							<a href={flowHref(test.key)}>{test.title}</a>
							{#if view.technical}
								<div class="muted">
									line {test.line}{test.dynamic ? ' · title generated at run time' : ''}
								</div>
							{/if}
						</div>
					</ui5-table-cell>
					<ui5-table-cell>{test.steps.length}</ui5-table-cell>
					<ui5-table-cell>
						<div class="row">
							{#if errors}<ui5-tag design="Negative">{plural(errors, 'problem')}</ui5-tag>{/if}
							{#if warnings}
								<ui5-tag design="Critical">{plural(warnings, 'warning')}</ui5-tag>
							{/if}
							{#if infos}<ui5-tag design="Information">{plural(infos, 'tip')}</ui5-tag>{/if}
							{#if !test.issues.length}<ui5-tag design="Positive">No issues</ui5-tag>{/if}
						</div>
					</ui5-table-cell>
					<ui5-table-cell><StatusTag status={lastStatus.get(test.key)} /></ui5-table-cell>
					<ui5-table-cell>
						<div class="row">
							<ui5-button icon="process" onclick={() => goto(flowHref(test.key))}>
								View steps
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
		min-width: 0;
	}
	.file-head ui5-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.file-head ui5-button {
		flex: none;
	}
	.spacer {
		flex: 1;
	}
</style>
