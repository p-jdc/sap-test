<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { settingsHref, testsHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import {
		addUftUpload,
		fetchUftRepository,
		getUftSetup,
		importUft,
		scanUft,
		startUftUpload
	} from '#lib/remote/uft.remote.js';
	import {
		decodeUftFile,
		UFT_FILE,
		UFT_LIMITS,
		type ImportedFile,
		type UftImportResult,
		type UftTarget,
		type UftTestSummary
	} from '#lib/shared/uft.js';

	const setup = getUftSetup();
	const gitReady = $derived(
		setup.current !== undefined &&
			setup.current.git.missing.length === 0 &&
			!setup.current.git.problem
	);

	type Source = { kind: 'upload'; id: string } | { kind: 'git' };
	let way = $state<'upload' | 'git'>('upload');
	let source = $state.raw<Source | null>(null);
	const scanned = $derived(source ? scanUft(source) : undefined);
	const tests = $derived(scanned?.current?.tests ?? []);

	const selected = new SvelteSet<string>();
	let replacePlans = $state(false);
	let busy = $state(false);
	let progress = $state<string | null>(null);
	let error = $state<string | null>(null);
	let imported = $state.raw<UftImportResult[]>([]);
	let picker = $state<HTMLInputElement>();

	function choose(next: 'upload' | 'git') {
		way = next;
		source = next === 'git' ? { kind: 'git' } : null;
		selected.clear();
		imported = [];
	}

	/** Characters per request: well under the server's 512 kB for one request body. */
	const CHUNK = 100_000;

	/** Ends a part before a character that UTF-16 keeps in two halves, so none is cut in two. */
	function partEnd(text: string, at: number): number {
		const end = Math.min(text.length, at + CHUNK);
		// A code point above U+FFFF that starts at end - 1 has its second half at end.
		return end < text.length && (text.codePointAt(end - 1) ?? 0) > 0xffff ? end - 1 : end;
	}

	async function upload(list: FileList | null) {
		const files = [...(list ?? [])].filter((f) => UFT_FILE.test(f.webkitRelativePath || f.name));
		if (picker) picker.value = '';
		if (files.length === 0) {
			error =
				'The folder holds no UFT scripts (Script.mts). Choose the folder of a UFT test, or a folder with several.';
			return;
		}
		if (files.length > UFT_LIMITS.files) {
			error = `The folder holds more than ${UFT_LIMITS.files} UFT files. Choose a part of it.`;
			return;
		}
		busy = true;
		error = null;
		imported = [];
		selected.clear();
		try {
			const { id } = await startUftUpload();
			let batch: { path: string; text: string }[] = [];
			let size = 0;
			const send = async () => {
				if (batch.length === 0) return;
				await addUftUpload({ id, parts: batch });
				batch = [];
				size = 0;
			};
			for (const [n, file] of files.entries()) {
				progress = `Reading ${n + 1} of ${files.length} files`;
				// oxlint-disable-next-line no-await-in-loop -- one file at a time keeps the browser's memory low
				const text = decodeUftFile(new Uint8Array(await file.arrayBuffer()));
				if (text.length > UFT_LIMITS.fileChars) continue;
				const path = file.webkitRelativePath || file.name;
				let at = 0;
				do {
					const end = partEnd(text, at);
					// oxlint-disable-next-line no-await-in-loop -- the parts of a file are appended in order
					if (size + (end - at) > CHUNK || batch.length >= 400) await send();
					batch.push({ path, text: text.slice(at, end) });
					size += end - at;
					at = end;
				} while (at < text.length);
			}
			await send();
			source = { kind: 'upload', id };
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
			progress = null;
		}
	}

	async function readGit() {
		busy = true;
		error = null;
		imported = [];
		selected.clear();
		progress = 'Reading the repository';
		try {
			await fetchUftRepository();
			source = { kind: 'git' };
			await scanUft({ kind: 'git' }).refresh();
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
			progress = null;
		}
	}

	async function runImport() {
		if (!source || selected.size === 0) return;
		busy = true;
		error = null;
		try {
			imported = await importUft({ source, paths: [...selected], replacePlans });
			selected.clear();
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	const TARGET: Record<UftTarget, string> = {
		sapgui: 'SAP GUI → WebGUI',
		fiori: 'Fiori',
		mixed: 'SAP GUI → WebGUI and Fiori',
		other: 'Neither'
	};

	type Design = 'Positive' | 'Negative' | 'Critical' | 'Information' | 'Neutral';

	/** Where a UFT test stands on its way to being retired. */
	function stage(test: UftTestSummary): { text: string; design: Design; hint: string } {
		const m = test.imported;
		if (!m) return { text: 'Not imported', design: 'Neutral', hint: '' };
		if (m.open > 0)
			return {
				text: `${m.open} to do`,
				design: 'Critical',
				hint: 'Statements not translated yet, marked TODO UFT in the test file'
			};
		if (m.fixme)
			return {
				text: 'Ready to run',
				design: 'Information',
				hint: 'Nothing left to translate: change test.fixme to test and run it'
			};
		if (!m.reviewer)
			return {
				text: 'Needs review',
				design: 'Information',
				hint: 'Whoever checked the test puts their name in its first line'
			};
		if (m.streak >= m.target)
			return {
				text: 'UFT test can go',
				design: 'Positive',
				hint: `Passed ${m.streak} times in a row, checked by ${m.reviewer}`
			};
		if (m.lastStatus && m.lastStatus !== 'passed')
			return { text: `Last run ${m.lastStatus}`, design: 'Negative', hint: 'See Results' };
		return {
			text: `${m.streak} of ${m.target} passes`,
			design: 'Information',
			hint: `Passes in a row needed before the UFT test is retired`
		};
	}

	const counts = $derived({
		imported: tests.filter((t) => t.imported).length,
		retired: tests.filter((t) => stage(t).design === 'Positive').length
	});

	const OUTCOME: Record<ImportedFile, string> = {
		written: 'written',
		replaced: 'replaced',
		kept: 'kept as it was'
	};

	const allSelected = $derived(tests.length > 0 && tests.every((t) => selected.has(t.path)));
	function toggleAll(on: boolean) {
		for (const t of tests) {
			if (on) selected.add(t.path);
			else selected.delete(t.path);
		}
	}
	function toggle(path: string, on: boolean) {
		if (on) selected.add(path);
		else selected.delete(path);
	}
	const share = (t: UftTestSummary) =>
		t.statements === 0 ? 0 : Math.round((t.translated / t.statements) * 100);
</script>

<div class="page-head">
	<ui5-title level="H2">Move from UFT</ui5-title>
</div>

<ui5-message-strip design="Information" hide-close-button>
	{#if view.technical}
		Reads UFT GUI tests (Action&lt;n&gt;/Script.mts and object repositories exported as XML) from an
		uploaded folder or a Git repository and translates each into a Playwright test: SAP GUI for
		Windows into SAP WebGUI with SID locators (the IDs of SAP GUI Scripting that UFT recorded), web
		and SAPUI5 objects into UI5 locators. What has no certain counterpart stays in the test as a
		comment marked <span class="mono">TODO UFT</span>, and the test stays
		<span class="mono">test.fixme</span> until none is left. Each test also gets a plan in
		<span class="mono">sap-tests/specs/uft-&lt;name&gt;.plan.md</span>. A UFT test can go once its
		translation was checked and it has passed {setup.current?.retireAfter ?? ''} times in a row.
	{:else}
		Bring your UFT tests into this app. SAP GUI tests become WebGUI tests in the browser, Fiori
		tests stay Fiori tests. Steps the import cannot translate are marked for a person, and the list
		below shows when a UFT test can be retired.
	{/if}
</ui5-message-strip>

<ui5-card class="block">
	<ui5-card-header slot="header" title-text="Where the UFT tests are"></ui5-card-header>
	<div class="card-body">
		<ui5-segmented-button
			accessible-name="Where the UFT tests are"
			onselection-change={(e: CustomEvent<{ selectedItems: HTMLElement[] }>) =>
				choose(e.detail.selectedItems[0]?.dataset.way === 'git' ? 'git' : 'upload')}
		>
			<ui5-segmented-button-item data-way="upload" selected={way === 'upload' || undefined}>
				Folder on this computer
			</ui5-segmented-button-item>
			<ui5-segmented-button-item data-way="git" selected={way === 'git' || undefined}>
				Git repository
			</ui5-segmented-button-item>
		</ui5-segmented-button>

		{#if way === 'upload'}
			<p class="muted">
				Choose the folder of a UFT test, or a folder with several. Only the scripts and the object
				repositories exported as XML are sent, not the binary files of UFT.
			</p>
			<div class="row">
				<input
					bind:this={picker}
					class="picker"
					type="file"
					webkitdirectory
					multiple
					aria-label="Folder with UFT tests"
					onchange={(e) => upload(e.currentTarget.files)}
				/>
				<ui5-button icon="attachment" disabled={busy || undefined} onclick={() => picker?.click()}>
					Choose folder…
				</ui5-button>
			</div>
		{:else if setup.current && !gitReady}
			<ui5-message-strip design="Critical" hide-close-button>
				{setup.current.git.problem ?? 'The Git repository is not set up yet.'}
				<a href={settingsHref()}>Open Settings</a>
			</ui5-message-strip>
		{:else if setup.current}
			<div class="row">
				<span class="mono">{setup.current.git.repository}</span>
				<ui5-button icon="refresh" disabled={busy || undefined} onclick={readGit}>
					Read the tests
				</ui5-button>
			</div>
		{/if}
		{#if busy}
			<div class="row">
				<ui5-busy-indicator active size="S"></ui5-busy-indicator>
				<span class="muted">{progress ?? 'Working'}</span>
			</div>
		{/if}
	</div>
</ui5-card>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if scanned?.error}
	<ui5-message-strip design="Negative" hide-close-button>
		{errorMessage(scanned.error)}
	</ui5-message-strip>
{:else if scanned && !scanned.ready}
	<ui5-busy-indicator active></ui5-busy-indicator>
{:else if scanned && scanned.current === null && !busy}
	<p class="muted">Not read yet: read the tests from the repository first.</p>
{:else if scanned?.current}
	{@const result = scanned.current}
	{#each result.notes as note (note)}
		<ui5-message-strip design="Critical" hide-close-button>{note}</ui5-message-strip>
	{/each}
	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="UFT tests"
			subtitle-text={`${tests.length} found${result.origin ? ` (${result.origin})` : ''} · ${counts.imported} imported · ${counts.retired} can be retired`}
		></ui5-card-header>
		<div class="card-body">
			{#if tests.length === 0}
				<p class="muted">No UFT test in this source.</p>
			{:else}
				<ui5-table accessible-name="UFT tests">
					<ui5-table-header-row slot="headerRow">
						<ui5-table-header-cell width="3rem">
							<ui5-checkbox
								accessible-name="Select all"
								checked={allSelected || undefined}
								onchange={(e: Event) => toggleAll((e.target as HTMLInputElement).checked)}
							></ui5-checkbox>
						</ui5-table-header-cell>
						<ui5-table-header-cell min-width="14rem">Test</ui5-table-header-cell>
						<ui5-table-header-cell>Drives</ui5-table-header-cell>
						<ui5-table-header-cell min-width="10rem">Translated</ui5-table-header-cell>
						<ui5-table-header-cell min-width="10rem">Status</ui5-table-header-cell>
					</ui5-table-header-row>
					{#each tests as test (test.path)}
						{@const s = stage(test)}
						<ui5-table-row>
							<ui5-table-cell>
								<ui5-checkbox
									accessible-name="Select {test.name}"
									checked={selected.has(test.path) || undefined}
									onchange={(e: Event) => toggle(test.path, (e.target as HTMLInputElement).checked)}
								></ui5-checkbox>
							</ui5-table-cell>
							<ui5-table-cell>
								<div>
									<strong>{test.name}</strong>
									<div class="muted">{test.actions.join(' · ')}</div>
									{#if view.technical}
										<div class="muted mono">{test.path}</div>
										<div class="muted mono">sap-tests/{test.imported?.spec ?? test.spec}</div>
									{/if}
								</div>
							</ui5-table-cell>
							<ui5-table-cell>{TARGET[test.target]}</ui5-table-cell>
							<ui5-table-cell>
								<div class="translated">
									<ui5-progress-indicator
										value={share(test)}
										display-value="{test.translated} of {test.statements}"
										accessible-name="{test.translated} of {test.statements} statements translated"
									></ui5-progress-indicator>
								</div>
							</ui5-table-cell>
							<ui5-table-cell>
								<div>
									<ui5-tag design={s.design}>{s.text}</ui5-tag>
									{#if s.hint}<div class="muted">{s.hint}</div>{/if}
								</div>
							</ui5-table-cell>
						</ui5-table-row>
					{/each}
				</ui5-table>
			{/if}
		</div>
	</ui5-card>

	{#if tests.length > 0}
		<ui5-card class="block form-card">
			<ui5-card-header
				slot="header"
				title-text="Import"
				subtitle-text={setup.current
					? `SAP GUI tests into tests/${setup.current.folders.webgui ?? '?'}, Fiori tests into tests/${setup.current.folders.fiori ?? '?'}`
					: ''}
			></ui5-card-header>
			<div class="form">
				<ui5-label for="replace" show-colon>Plans imported before</ui5-label>
				<ui5-checkbox
					id="replace"
					text="Replace them with the UFT test as it is now"
					checked={replacePlans || undefined}
					onchange={(e: Event) => (replacePlans = (e.target as HTMLInputElement).checked)}
				></ui5-checkbox>
				<span></span>
				<p class="muted">
					A test file that is already there is never replaced: it may be worked on by now.
				</p>
				<span></span>
				<div class="row">
					<ui5-button
						icon="process"
						design="Emphasized"
						disabled={busy || selected.size === 0 || undefined}
						onclick={runImport}
					>
						Import {selected.size === 1 ? 'one test' : `${selected.size} tests`}
					</ui5-button>
					{#if selected.size === 0}<span class="muted">Select tests above first.</span>{/if}
				</div>
			</div>
		</ui5-card>
	{/if}
{/if}

{#if imported.length > 0}
	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Imported"
			subtitle-text="Do the steps marked TODO UFT, run each test, and check every line marked check once"
		></ui5-card-header>
		<div class="card-body">
			<ul class="imported">
				{#each imported as result (result.path)}
					<li>
						<strong>{result.name}</strong>: {result.translated} of {result.statements} statements translated;
						test file {OUTCOME[result.spec.outcome]}, plan {OUTCOME[result.plan.outcome]}
						<div class="muted mono">sap-tests/{result.spec.file}</div>
						<div class="muted mono">sap-tests/{result.plan.file}</div>
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
	.picker {
		display: none;
	}
	.translated {
		min-width: 9rem;
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
	.form p {
		margin: 0;
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
