<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { settingsHref, testsHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import {
		getOctaneSetup,
		importOctaneTests,
		searchOctaneTests
	} from '#lib/remote/octane.remote.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';
	import type { ImportedFile, OctaneImportResult } from '#lib/shared/octane.js';

	const setup = getOctaneSetup();
	const env = getEnvStatus();
	const ready = $derived(setup.current?.missing.length === 0);

	let draft = $state('');
	let search = $state({ text: '', offset: 0 });
	const results = $derived(ready ? searchOctaneTests(search) : undefined);
	const pageSize = $derived(setup.current?.pageSize ?? 50);

	const selected = new SvelteSet<string>();
	let chosenFolder = $state<string | null>(null);
	// Every folder a system records into, named by its system (sap-tests/systems.json).
	const folders = $derived(
		(setup.current?.folders ?? []).map((folder) => {
			const system = env.current?.systems.find((s) => s.record.some((t) => t.folder === folder));
			return { folder, label: system ? `${system.title} (tests/${folder})` : `tests/${folder}` };
		})
	);
	const folder = $derived(
		folders.find((f) => f.folder === chosenFolder)?.folder ?? folders[0]?.folder
	);
	let replacePlans = $state(false);

	let busy = $state(false);
	let error = $state<string | null>(null);
	let imported = $state.raw<OctaneImportResult[]>([]);

	function find() {
		selected.clear();
		search = { text: draft.trim(), offset: 0 };
	}

	function page(offset: number) {
		search = { ...search, offset };
	}

	async function runImport() {
		if (!folder || selected.size === 0) return;
		busy = true;
		error = null;
		try {
			imported = await importOctaneTests({ ids: [...selected], folder, replacePlans });
			selected.clear();
			await results?.refresh();
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	const OUTCOME: Record<ImportedFile, string> = {
		written: 'written',
		replaced: 'replaced',
		kept: 'kept as it was'
	};

	const allOnPage = $derived(
		(results?.current?.tests.length ?? 0) > 0 &&
			(results?.current?.tests ?? []).every((t) => selected.has(t.id))
	);
	function toggleAll(on: boolean) {
		for (const t of results?.current?.tests ?? []) {
			if (on) selected.add(t.id);
			else selected.delete(t.id);
		}
	}
	function toggle(id: string, on: boolean) {
		if (on) selected.add(id);
		else selected.delete(id);
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Import from Octane</ui5-title>
</div>

<ui5-message-strip design="Information" hide-close-button>
	{#if view.technical}
		Reads manual and Gherkin tests from OpenText Octane through its REST API, signed in with the API
		access key from <a href={settingsHref()}>Settings</a>. Each test becomes a plan in
		<span class="mono">sap-tests/specs/octane-&lt;id&gt;-&lt;name&gt;.plan.md</span> (the planner
		agent's format) and a test file in the chosen folder with one empty
		<span class="mono">test.step</span> per step, marked <span class="mono">test.fixme</span> and
		tagged <span class="mono">@octane-&lt;id&gt;</span>. A person checks the plan; the generator
		agent or a person fills in the steps. Importing again never replaces a test file, and a plan
		only when asked to.
	{:else}
		Bring test cases written in OpenText Octane into the app. Each one becomes a plan with its steps
		and an empty test with the same steps, ready to be filled in and checked by a person.
	{/if}
</ui5-message-strip>

{#if setup.current && !ready}
	<ui5-message-strip design="Critical" hide-close-button>
		The connection to Octane is not set up yet{view.technical
			? `: ${setup.current.missing.join(', ')}`
			: ''}. <a href={settingsHref()}>Open Settings</a>
	</ui5-message-strip>
{/if}

{#if ready}
	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Tests in Octane"
			subtitle-text={setup.current?.server
				? `Manual and Gherkin tests on ${setup.current.server}`
				: ''}
		></ui5-card-header>
		<div class="card-body">
			<div class="row">
				<ui5-input
					class="search"
					value={draft}
					placeholder="Part of the name, or the ID"
					accessible-name="Search tests by name or ID"
					oninput={(e: Event) => (draft = (e.target as HTMLInputElement).value)}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && find()}
				></ui5-input>
				<ui5-button icon="search" onclick={find}>Search</ui5-button>
			</div>

			{#if results?.error}
				<ui5-message-strip design="Negative" hide-close-button>
					{errorMessage(results.error)}
				</ui5-message-strip>
			{:else if !results?.current}
				<ui5-busy-indicator active></ui5-busy-indicator>
			{:else if results.current.tests.length === 0}
				<p class="muted">No manual or Gherkin test matches.</p>
			{:else}
				{@const found = results.current}
				<ui5-table accessible-name="Tests in Octane">
					<ui5-table-header-row slot="headerRow">
						<ui5-table-header-cell width="3rem">
							<ui5-checkbox
								accessible-name="Select all on this page"
								checked={allOnPage || undefined}
								onchange={(e: Event) => toggleAll((e.target as HTMLInputElement).checked)}
							></ui5-checkbox>
						</ui5-table-header-cell>
						<ui5-table-header-cell min-width="16rem">Test</ui5-table-header-cell>
						<ui5-table-header-cell>Kind</ui5-table-header-cell>
						<ui5-table-header-cell>Phase</ui5-table-header-cell>
						<ui5-table-header-cell min-width="12rem">Imported</ui5-table-header-cell>
					</ui5-table-header-row>
					{#each found.tests as test (test.id)}
						<ui5-table-row>
							<ui5-table-cell>
								<ui5-checkbox
									accessible-name="Select {test.name}"
									checked={selected.has(test.id) || undefined}
									onchange={(e: Event) => toggle(test.id, (e.target as HTMLInputElement).checked)}
								></ui5-checkbox>
							</ui5-table-cell>
							<ui5-table-cell>
								<div>
									<ui5-link href={test.link} target="_blank" tooltip="Open in Octane">
										{test.name}
									</ui5-link>
									<div class="muted">
										{test.id}{test.productAreas.length
											? ` · ${test.productAreas.join(', ')}`
											: ''}{test.tags.length ? ` · ${test.tags.join(', ')}` : ''}
									</div>
								</div>
							</ui5-table-cell>
							<ui5-table-cell>{test.kind === 'gherkin' ? 'Gherkin' : 'Manual'}</ui5-table-cell>
							<ui5-table-cell>{test.phase ?? ''}</ui5-table-cell>
							<ui5-table-cell>
								{#if test.plan || test.spec}
									<div>
										<ui5-tag design="Positive">Imported</ui5-tag>
										{#if view.technical}
											<div class="muted mono">{test.plan ?? ''}</div>
											<div class="muted mono">{test.spec ?? ''}</div>
										{/if}
									</div>
								{/if}
							</ui5-table-cell>
						</ui5-table-row>
					{/each}
				</ui5-table>
				<div class="row pager">
					<span class="muted">
						{found.offset + 1}–{found.offset + found.tests.length} of {found.total}
					</span>
					<ui5-button
						design="Transparent"
						disabled={found.offset === 0 || undefined}
						onclick={() => page(Math.max(0, found.offset - pageSize))}
					>
						Previous
					</ui5-button>
					<ui5-button
						design="Transparent"
						disabled={found.offset + pageSize >= found.total || undefined}
						onclick={() => page(found.offset + pageSize)}
					>
						Next
					</ui5-button>
				</div>
			{/if}
		</div>
	</ui5-card>

	<ui5-card class="block form-card">
		<ui5-card-header slot="header" title-text="Import"></ui5-card-header>
		<div class="form">
			<ui5-label for="folder" show-colon>Save the tests in</ui5-label>
			<ui5-select
				id="folder"
				onchange={(e: CustomEvent<{ selectedOption: HTMLElement }>) =>
					(chosenFolder = e.detail.selectedOption.dataset.value ?? null)}
			>
				{#each folders as f (f.folder)}
					<ui5-option data-value={f.folder} selected={f.folder === folder || undefined}>
						{f.label}
					</ui5-option>
				{/each}
			</ui5-select>

			<ui5-label for="replace" show-colon>Plans imported before</ui5-label>
			<ui5-checkbox
				id="replace"
				text="Replace them with the test as it is in Octane now"
				checked={replacePlans || undefined}
				onchange={(e: Event) => (replacePlans = (e.target as HTMLInputElement).checked)}
			></ui5-checkbox>

			<span></span>
			<div class="row">
				<ui5-button
					icon="download"
					design="Emphasized"
					disabled={busy || selected.size === 0 || !folder || undefined}
					onclick={runImport}
				>
					Import {selected.size === 1 ? 'one test' : `${selected.size} tests`}
				</ui5-button>
				{#if busy}<ui5-busy-indicator active size="S"></ui5-busy-indicator>{/if}
				{#if selected.size === 0}<span class="muted">Select tests above first.</span>{/if}
			</div>
		</div>
	</ui5-card>
{/if}

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if imported.length > 0}
	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Imported"
			subtitle-text="Check each plan before code is written from it"
		></ui5-card-header>
		<div class="card-body">
			<ul class="imported">
				{#each imported as result (result.id)}
					<li>
						<strong>{result.name}</strong> ({result.id}): plan {OUTCOME[result.plan.outcome]}, test
						file {OUTCOME[result.spec.outcome]}
						<div class="muted mono">sap-tests/{result.plan.file}</div>
						<div class="muted mono">sap-tests/{result.spec.file}</div>
						{#each result.notes as note (note)}<div class="muted">{note}</div>{/each}
					</li>
				{/each}
			</ul>
			<p><a href={testsHref()}>Open the tests</a></p>
		</div>
	</ui5-card>
{/if}

<style>
	.block {
		margin-bottom: 1rem;
	}
	.search {
		flex: 1;
		min-width: 12rem;
		max-width: 32rem;
	}
	.pager {
		justify-content: flex-end;
		margin-top: 0.5rem;
	}
	.form-card {
		max-width: 44rem;
	}
	.form {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.75rem 1rem;
		align-items: center;
		padding: 1rem;
	}
	.form ui5-select {
		justify-self: start;
		min-width: 16rem;
	}
	.imported {
		margin: 0;
		padding-left: 1.25rem;
	}
	.imported li + li {
		margin-top: 0.5rem;
	}
	@media (max-width: 600px) {
		.form {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
		}
	}
</style>
