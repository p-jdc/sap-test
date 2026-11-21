<script lang="ts">
	import { settingsHref, testsHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';
	import { getRecorder, startRecorder, stopRecorder } from '#lib/remote/recorder.remote.js';

	const rec = getRecorder();
	const env = getEnvStatus();

	let surface = $state<'fiori' | 'webgui' | 'ariba'>('fiori');
	let name = $state('');
	let url = $state('');
	let saveStorage = $state(false);
	let noLogin = $state(false);
	let error = $state<string | null>(null);

	const recording = $derived(rec.current?.status === 'recording');
	$effect(() => {
		if (!recording) return;
		const t = setInterval(() => void rec.refresh(), 1000);
		return () => clearInterval(t);
	});

	const has = (n: string) => env.current?.vars.find((v) => v.name === n)?.set ?? false;
	// Only the Fiori recorder can skip the login; it then needs nothing but a page to open.
	const withoutLogin = $derived(surface === 'fiori' && noLogin);
	const ready = $derived(
		surface === 'ariba'
			? has('ARIBA_URL') || !!url
			: withoutLogin
				? has('SAP_URL') || !!url.trim()
				: has('SAP_URL') && has('SAP_USERNAME') && has('SAP_PASSWORD')
	);

	async function start() {
		error = null;
		try {
			await startRecorder({ surface, name, url: url.trim(), saveStorage, noLogin: withoutLogin });
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
		Fiori / UI5 records with the recorder in <span class="mono">sap-tests/sap-plugin</span> on stock
		Playwright: UI5 itself describes each control, so the test names a row by its data and not by
		its position. WebGUI and Ariba start
		<span class="mono">npx playwright codegen</span> from the Playwright-SAP recorder (guide §4.4).
		Either way the recorded test runs on stock Playwright. The browser opens on the machine that
		runs this app, so record from a local install. Fiori and WebGUI log in automatically with the
		credentials from
		<a href={settingsHref()}>Settings</a> or <span class="mono">sap-tests/.env</span>; for Ariba you
		log in by hand.
	{:else}
		Show the app once what to do, and it can repeat it as a test. How it works:
		<ol class="how">
			<li>Pick the SAP application and give the test a name.</li>
			<li>
				Press “Start recording”. A browser window opens on this computer and logs in to SAP for you
				(in Ariba you log in yourself).
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
		<ui5-label for="surface" show-colon>SAP application</ui5-label>
		<ui5-segmented-button
			id="surface"
			onselection-change={(e: CustomEvent<{ selectedItems: HTMLElement[] }>) => {
				const value = e.detail.selectedItems[0]?.dataset.value;
				if (value === 'fiori' || value === 'webgui' || value === 'ariba') surface = value;
			}}
		>
			<ui5-segmented-button-item data-value="fiori" selected={surface === 'fiori' || undefined}>
				Fiori / UI5
			</ui5-segmented-button-item>
			<ui5-segmented-button-item data-value="webgui" selected={surface === 'webgui' || undefined}>
				WebGUI
			</ui5-segmented-button-item>
			<ui5-segmented-button-item data-value="ariba" selected={surface === 'ariba' || undefined}>
				Ariba
			</ui5-segmented-button-item>
		</ui5-segmented-button>

		<ui5-label for="name" required show-colon>Name of the test</ui5-label>
		<ui5-input
			id="name"
			value={name}
			placeholder="create sales order"
			oninput={(e: Event) => (name = (e.target as HTMLInputElement).value)}
		></ui5-input>

		{#if surface === 'fiori'}
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
					? surface === 'ariba'
						? 'defaults to ARIBA_URL'
						: 'defaults to SAP_URL (same host only)'
					: 'Optional: leave empty to start on the usual start page'}
			oninput={(e: Event) => (url = (e.target as HTMLInputElement).value)}
		></ui5-input>

		{#if view.technical}
			<ui5-label for="storage" show-colon>Save session</ui5-label>
			<div class="row">
				<ui5-switch
					id="storage"
					checked={saveStorage || undefined}
					onchange={(e: Event) => (saveStorage = (e.target as HTMLInputElement).checked)}
				></ui5-switch>
				<span class="muted">Writes .auth/{surface}.json for storageState reuse (guide §7.4)</span>
			</div>
		{/if}

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
						The connection to this SAP application is not set up yet.
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
	.form ui5-segmented-button {
		justify-self: start;
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
