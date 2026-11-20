<script lang="ts">
	import { testsHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';
	import { getRecorder, startRecorder, stopRecorder } from '#lib/remote/recorder.remote.js';

	const rec = getRecorder();
	const env = getEnvStatus();

	let surface = $state<'fiori' | 'webgui' | 'ariba'>('fiori');
	let name = $state('');
	let url = $state('');
	let saveStorage = $state(false);
	let error = $state<string | null>(null);

	const recording = $derived(rec.current?.status === 'recording');
	$effect(() => {
		if (!recording) return;
		const t = setInterval(() => void rec.refresh(), 1000);
		return () => clearInterval(t);
	});

	const has = (n: string) => env.current?.vars.find((v) => v.name === n)?.set ?? false;
	const ready = $derived(
		surface === 'ariba'
			? has('ARIBA_URL') || !!url
			: has('SAP_URL') && has('SAP_USERNAME') && has('SAP_PASSWORD')
	);

	async function start() {
		error = null;
		try {
			await startRecorder({ surface, name, url, saveStorage });
		} catch (e) {
			error = errorMessage(e);
		}
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Record a flow</ui5-title>
</div>

<ui5-message-strip design="Information" hide-close-button>
	Starts <span class="mono">npx playwright codegen</span> from Playwright-SAP (guide §4.4). The
	browser and the recorder window open on the machine that runs this app, so record from a local
	install. Fiori and WebGUI log in automatically with the credentials in
	<span class="mono">sap-tests/.env</span>; for Ariba you log in by hand.
</ui5-message-strip>

<div class="form">
	<ui5-label for="surface" show-colon>Surface</ui5-label>
	<ui5-segmented-button
		id="surface"
		onselection-change={(e: CustomEvent<{ selectedItems: HTMLElement[] }>) =>
			(surface = e.detail.selectedItems[0].dataset.value as typeof surface)}
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

	<ui5-label for="name" required show-colon>Flow name</ui5-label>
	<ui5-input
		id="name"
		value={name}
		placeholder="create sales order"
		oninput={(e: Event) => (name = (e.target as HTMLInputElement).value)}
	></ui5-input>

	<ui5-label for="url" show-colon>Start URL</ui5-label>
	<ui5-input
		id="url"
		value={url}
		placeholder={surface === 'ariba' ? 'defaults to ARIBA_URL' : 'defaults to SAP_URL'}
		oninput={(e: Event) => (url = (e.target as HTMLInputElement).value)}
	></ui5-input>

	<ui5-label for="storage" show-colon>Save session</ui5-label>
	<div class="row">
		<ui5-switch
			id="storage"
			checked={saveStorage || undefined}
			onchange={(e: Event) => (saveStorage = (e.target as HTMLInputElement).checked)}
		></ui5-switch>
		<span class="muted">Writes .auth/{surface}.json for storageState reuse (guide §7.4)</span>
	</div>

	<span></span>
	<div class="row">
		{#if recording}
			<ui5-button icon="stop" design="Negative" onclick={() => stopRecorder()}>
				Stop recorder
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
			<span class="muted">Missing settings in sap-tests/.env for this surface.</span>
		{/if}
	</div>
</div>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if rec.current && rec.current.status !== 'idle'}
	<ui5-panel
		header-text="Recorder: {rec.current.status}{rec.current.file ? ` · ${rec.current.file}` : ''}"
		fixed
	>
		{#if rec.current.status === 'saved' && rec.current.file}
			<ui5-message-strip design="Positive" hide-close-button>
				Saved. Next: clean it up with the AI assistant (guide §4.7), then
				<a href={testsHref()}>open it in Tests & Flows</a> to check the rules and run it.
			</ui5-message-strip>
		{/if}
		<pre class="log">{rec.current.log.join('\n')}</pre>
	</ui5-panel>
{/if}

<style>
	.form {
		display: grid;
		grid-template-columns: max-content minmax(0, 480px);
		gap: 0.75rem 1rem;
		align-items: center;
		margin: 1rem 0;
	}
</style>
