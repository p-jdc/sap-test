<script lang="ts">
	import { settingsHref, testsHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { RECORDER_LABEL } from '#lib/shared/format.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';
	import { getRecorder, startRecorder, stopRecorder } from '#lib/remote/recorder.remote.js';

	const rec = getRecorder();
	const env = getEnvStatus();

	// Every folder a system records into (sap-tests/systems.json), the systems needed to get started
	// first.
	const targets = $derived(
		(env.current?.systems ?? [])
			.toSorted((a, b) => Number(!!a.optional) - Number(!!b.optional))
			.flatMap((system) =>
				system.record.map((target) => {
					const kind = target.recorder === 'web' ? '' : ` · ${RECORDER_LABEL[target.recorder]}`;
					// Two folders with the same recorder are told apart by the folder.
					const shared = system.record.filter((t) => t.recorder === target.recorder).length > 1;
					return {
						system,
						target,
						label: `${system.title}${kind}${shared ? ` (tests/${target.folder})` : ''}`,
						shared
					};
				})
			)
	);
	let chosen = $state<string | null>(null);
	const current = $derived(targets.find((t) => t.target.folder === chosen) ?? targets[0]);

	let name = $state('');
	let url = $state('');
	let noLogin = $state(false);
	let error = $state<string | null>(null);

	const recording = $derived(rec.current?.status === 'recording');
	$effect(() => {
		if (!recording) return;
		const t = setInterval(() => void rec.refresh(), 1000);
		return () => clearInterval(t);
	});

	const has = (n: string) => env.current?.vars.find((v) => v.name === n)?.set ?? false;
	// Only the UI5 recorder can skip the login; it then needs nothing but a page to open.
	const canSkipLogin = $derived(!!current?.target.noLoginFolder);
	const withoutLogin = $derived(canSkipLogin && noLogin);
	// The recorder signs in itself, with the system's stored credentials.
	const signsIn = $derived(!!current && current.target.recorder !== 'web' && !withoutLogin);
	const ready = $derived(
		!!current &&
			(signsIn
				? has(current.system.env.url) &&
					has(current.system.env.user) &&
					has(current.system.env.password)
				: has(current.system.env.url) || !!url.trim())
	);

	async function start() {
		if (!current) return;
		error = null;
		try {
			await startRecorder({
				folder: current.target.folder,
				name,
				url: url.trim(),
				noLogin: withoutLogin
			});
		} catch (e) {
			error = errorMessage(e);
		}
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Record a test</ui5-title>
</div>

<ui5-message-strip design="Information" hide-close-button>
	{#if view.technical}
		The systems and their folders come from <span class="mono">sap-tests/systems.json</span>. Fiori
		/ UI5 records with the recorder in <span class="mono">sap-tests/sap-plugin</span> on stock
		Playwright: UI5 itself describes each control, so the test names a row by its data and not by
		its position. WebGUI (a folder named <span class="mono">webgui</span>) and the systems that do
		not sign in with SAP's login start
		<span class="mono">npx playwright codegen</span> from the Playwright-SAP recorder (guide §4.4).
		Either way the recorded test runs on stock Playwright. The browser opens on the machine that
		runs this app, so record from a local install. Fiori and WebGUI log in automatically with the
		system's credentials from
		<a href={settingsHref()}>Settings</a> or <span class="mono">sap-tests/.env</span>; in other
		systems you sign in by hand.
	{:else}
		Show the app once what to do, and it can repeat it as a test. How it works:
		<ol class="how">
			<li>Pick the system and give the test a name.</li>
			<li>
				Press “Start recording”. A browser window opens on this computer and logs in to SAP for you
				(in other systems, such as Ariba, you sign in yourself).
			</li>
			<li>
				Do the task as you normally would. Every click and entry is written down; for Fiori a red
				“Recording” mark at the top of the page counts them.
			</li>
			<li>Close the browser window when you are done. The test is saved.</li>
		</ol>
	{/if}
</ui5-message-strip>

<ui5-card class="form-card">
	<div class="form">
		<ui5-label for="target" show-colon>System</ui5-label>
		<ui5-select
			id="target"
			onchange={(e: CustomEvent<{ selectedOption: HTMLElement }>) =>
				(chosen = e.detail.selectedOption.dataset.value ?? null)}
		>
			{#each targets as t (t.target.folder)}
				<ui5-option
					data-value={t.target.folder}
					selected={t.target.folder === current?.target.folder || undefined}
				>
					{t.label}{view.technical && !t.shared ? ` (tests/${t.target.folder})` : ''}
				</ui5-option>
			{/each}
		</ui5-select>

		<ui5-label for="name" required show-colon>Name of the test</ui5-label>
		<ui5-input
			id="name"
			value={name}
			placeholder="create sales order"
			oninput={(e: Event) => (name = (e.target as HTMLInputElement).value)}
		></ui5-input>

		{#if canSkipLogin}
			<ui5-label for="nologin" show-colon>Without login</ui5-label>
			<div class="row">
				<ui5-switch
					id="nologin"
					checked={noLogin || undefined}
					onchange={(e: Event) => (noLogin = (e.target as HTMLInputElement).checked)}
				></ui5-switch>
				<span class="muted">For a page that needs no SAP login, such as a demo app</span>
			</div>
		{/if}

		<ui5-label for="url" show-colon>Start page</ui5-label>
		<ui5-input
			id="url"
			value={url}
			placeholder={withoutLogin
				? 'https://… the page to record'
				: view.technical
					? signsIn
						? `defaults to ${current?.system.env.url} (same host only)`
						: `defaults to ${current?.system.env.url}`
					: 'Optional: leave empty to start on the usual start page'}
			oninput={(e: Event) => (url = (e.target as HTMLInputElement).value)}
		></ui5-input>

		<span></span>
		<div class="row">
			{#if recording}
				<ui5-button icon="stop" design="Negative" onclick={() => stopRecorder()}>
					Stop recording
				</ui5-button>
			{:else}
				<ui5-button
					icon="record"
					design="Emphasized"
					onclick={start}
					disabled={!name.trim() || !ready || undefined}
				>
					Start recording
				</ui5-button>
			{/if}
			{#if !ready && env.current}
				<span class="muted">
					{#if withoutLogin}
						Enter the start page to record.
					{:else}
						The connection to this system is not set up yet.
						<a href={settingsHref()}>Open Settings</a>
					{/if}
				</span>
			{:else if !name.trim() && !recording}
				<span class="muted">Give the test a name first.</span>
			{/if}
		</div>
	</div>
</ui5-card>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if rec.current && rec.current.status !== 'idle'}
	{@const status = rec.current.status}
	{#if status === 'recording'}
		<ui5-message-strip design="Information" hide-close-button>
			Recording. Do your task in the browser window that opened, then close that window to save the
			test.
		</ui5-message-strip>
	{:else if status === 'saved'}
		<ui5-message-strip design="Positive" hide-close-button>
			Your test is saved. <a href={testsHref()}>Open it under Tests</a> to look at its steps and run
			it.
			{#if view.technical}Clean it up with the AI assistant first (guide §4.7).{/if}
		</ui5-message-strip>
	{:else}
		<ui5-message-strip design="Negative" hide-close-button>
			The recording was not saved. This happens when the browser is closed before anything was done;
			otherwise the details below say what went wrong.
		</ui5-message-strip>
	{/if}
	{#if view.technical || status === 'error'}
		<ui5-panel
			header-text="Technical log{view.technical && rec.current.file
				? ` · ${rec.current.file}`
				: ''}"
			collapsed={!view.technical || undefined}
		>
			<pre class="log">{rec.current.log.join('\n')}</pre>
		</ui5-panel>
	{/if}
{/if}

<style>
	.form-card {
		max-width: 44rem;
		margin-bottom: 1rem;
	}
	.form {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.75rem 1rem;
		align-items: center;
		padding: 1rem;
	}
	.form ui5-input {
		width: 100%;
	}
	.how {
		margin: 0.25rem 0 0;
		padding-left: 1.25rem;
	}
	.form ui5-select {
		justify-self: start;
		min-width: 16rem;
	}
	@media (max-width: 600px) {
		.form {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
		}
		.form > :nth-child(even) {
			margin-bottom: 0.5rem;
		}
	}
</style>
