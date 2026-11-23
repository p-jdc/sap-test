<script lang="ts">
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import {
		clearOdataLog,
		getOdataEntitySets,
		getOdataRequest,
		getOdataRows,
		resetOdata,
		setOdataForTests,
		setOdataServiceAnswer,
		startOdata,
		stopOdata,
		watchOdataLive
	} from '#lib/remote/odata.remote.js';
	import type { OdataAnswer, OdataRequestSummary } from '#lib/shared/odata.js';

	const live = watchOdataLive();
	const snap = $derived(live.current);
	const status = $derived(snap?.status);

	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	/** The request opened below the log. */
	let selected = $state<number | null>(null);

	let answerService = $state('');
	let answerMode = $state<OdataAnswer['mode']>('fail');
	let failStatus = $state(503);
	let failMessage = $state('Service unavailable (OData mock)');
	let slowSeconds = $state(10);

	let dataService = $state('');
	let dataSet = $state('');
	const ROWS = 50;

	/** Runs an action and shows its error instead of throwing. */
	async function run(action: () => Promise<unknown>) {
		error = null;
		notice = null;
		busy = true;
		try {
			await action();
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	const select =
		<T extends string>(set: (value: T) => void) =>
		(e: CustomEvent<{ selectedOption: HTMLElement }>) => {
			const value = e.detail.selectedOption.dataset.value;
			if (value !== undefined) set(value as T);
		};
	const typed = (set: (value: string) => void) => (e: Event) =>
		set((e.target as HTMLInputElement).value);

	const services = $derived(snap?.services ?? []);
	/** The service chosen in a card, or the first one until one is chosen. */
	const chosenAnswerService = $derived(
		services.find((s) => s.name === answerService)?.name ?? services[0]?.name
	);
	const chosenDataService = $derived(
		services.find((s) => s.name === dataService)?.name ?? services[0]?.name
	);
	/** The chosen service's entity sets and the chosen set's entries. Read through `.current`, so a refresh
	 * shows. */
	const sets = $derived(chosenDataService ? getOdataEntitySets(chosenDataService) : undefined);
	const rows = $derived(
		chosenDataService && dataSet
			? getOdataRows({ service: chosenDataService, set: dataSet, top: ROWS })
			: undefined
	);
	const columns = $derived([
		...new Set((rows?.current?.rows ?? []).flatMap((row) => Object.keys(row)))
	]);
	const requests = $derived((snap?.requests ?? []).toReversed());
	const open = $derived(requests.find((r) => r.seq === selected));
	const answers = $derived(Object.entries(snap?.answers ?? {}));

	const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });

	/** The path without the service's base path, which the log shows next to it. */
	function shortUrl(request: OdataRequestSummary): string {
		const basePath = services.find((s) => s.name === request.service)?.basePath;
		const rest =
			basePath && request.url.startsWith(basePath)
				? request.url.slice(basePath.length)
				: request.url;
		return rest === '' ? '/' : rest;
	}

	const outcome = (request: OdataRequestSummary) => {
		if (request.status === 0) return { text: 'Caller gave up', design: 'Critical' } as const;
		if (request.status >= 400) return { text: String(request.status), design: 'Negative' } as const;
		return { text: String(request.status), design: 'Positive' } as const;
	};

	const describeAnswer = (answer: OdataAnswer) =>
		answer.mode === 'fail'
			? `Fails with HTTP ${answer.status}: ${answer.message}`
			: `Answers after ${answer.delayMs / 1000} s`;

	const MODE_HELP = {
		fail: 'Every request to the service gets this HTTP error, in the form SAP Gateway sends.',
		slow: 'Every request gets its normal answer, after the delay: to see how an app or test handles a slow system.'
	} as const;

	function answerToSet(): OdataAnswer {
		if (answerMode === 'fail') return { mode: 'fail', status: failStatus, message: failMessage };
		return { mode: 'slow', delayMs: Math.round(slowSeconds * 1000) };
	}

	/** A cell's text: complex values (an address, say) as JSON. */
	const cell = (value: unknown) =>
		value === null || value === undefined
			? ''
			: typeof value === 'object'
				? JSON.stringify(value)
				: String(value);

	/** JSON bodies indented, everything else as it came. */
	function pretty(body: string | undefined, type: string | undefined): string {
		if (!body) return '';
		if (!type?.includes('json')) return body;
		try {
			return JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			return body;
		}
	}

	async function refreshData() {
		await Promise.all([sets?.refresh(), rows?.refresh()]);
	}

	async function reset() {
		await run(async () => {
			await resetOdata();
			await refreshData();
			notice = 'The data is back as it is in the files. What tests or apps wrote is gone.';
		});
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Mock OData</ui5-title>
	{#if status?.running}
		<ui5-tag design="Information">Serving</ui5-tag>
	{:else if status}
		<ui5-tag design="Neutral">Stopped</ui5-tag>
	{/if}
	<span class="spacer"></span>
	{#if status?.running}
		<ui5-button icon="stop" disabled={busy || undefined} onclick={() => run(() => stopOdata())}>
			Stop
		</ui5-button>
	{/if}
</div>

<p class="muted intro">
	Stands in for SAP's OData services, with made-up data, so API tests and apps run without an SAP
	system. It shows every request it gets, and it can fail a service or answer late, to test how a
	test or an app handles a system that is down or slow.
</p>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}
{#if notice}
	<ui5-message-strip design="Information" onclose={() => (notice = null)}>
		{notice}
	</ui5-message-strip>
{/if}
{#if status?.error}
	<ui5-message-strip design="Negative" hide-close-button>{status.error}</ui5-message-strip>
{/if}

{#if !snap}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{:else if !status?.running}
	<ui5-card class="start">
		<ui5-card-header slot="header" title-text="Start the OData mock"></ui5-card-header>
		<div class="card-body">
			<p class="muted">
				It serves on this computer only, without a login, with the data from the files in the test
				project. Changes made through it last until it stops or the data is reset.
			</p>
			{#if view.technical}
				<p class="muted mono">
					Services: sap-tests/odata/metadata/options-per-service.json. Data:
					sap-tests/odata/mock/data/&lt;service&gt;/&lt;EntitySet&gt;.json.
				</p>
			{/if}
			<div class="row">
				<ui5-button
					design="Emphasized"
					icon="play"
					disabled={busy || undefined}
					onclick={() => run(() => startOdata())}
				>
					Start
				</ui5-button>
			</div>
		</div>
	</ui5-card>
{:else}
	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Services"
			subtitle-text="Where tests and apps on this computer reach them"
		></ui5-card-header>
		<div class="card-body">
			{#each services as service (service.name)}
				<div class="line">
					<span class="name">{service.name}</span>
					<span class="mono">{snap.odataUrl}{service.basePath}</span>
				</div>
			{/each}
			<div class="line switch">
				<ui5-switch
					id="for-tests"
					accessible-name="API tests started here call the mock"
					checked={snap.forTests || undefined}
					disabled={busy || undefined}
					onchange={(e: Event) => {
						const use = (e.target as HTMLInputElement).checked;
						void run(() => setOdataForTests(use));
					}}
				></ui5-switch>
				<ui5-label for="for-tests">API tests started in this app call the mock</ui5-label>
			</div>
			<p class="muted">
				{snap.forTests
					? 'Tests started here call the mock instead of the SAP system in the settings, until you switch this off or stop the mock.'
					: 'Tests started here call the SAP system in the settings.'}
			</p>
		</div>
	</ui5-card>

	<div class="grid">
		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="Answers"
				subtitle-text="Fail a service or answer late"
			></ui5-card-header>
			<div class="card-body">
				<div class="form">
					<ui5-label for="answer-service" show-colon>Service</ui5-label>
					<ui5-select id="answer-service" onchange={select<string>((v) => (answerService = v))}>
						{#each services as service (service.name)}
							<ui5-option
								data-value={service.name}
								selected={service.name === chosenAnswerService || undefined}
							>
								{service.name}
							</ui5-option>
						{/each}
					</ui5-select>
					<ui5-label for="answer-mode" show-colon>Answer</ui5-label>
					<ui5-select
						id="answer-mode"
						onchange={select<OdataAnswer['mode']>((v) => (answerMode = v))}
					>
						<ui5-option data-value="fail" selected={answerMode === 'fail' || undefined}>
							Fail
						</ui5-option>
						<ui5-option data-value="slow" selected={answerMode === 'slow' || undefined}>
							Answer late
						</ui5-option>
					</ui5-select>
					<span></span>
					<p class="muted">{MODE_HELP[answerMode]}</p>
					{#if answerMode === 'fail'}
						<ui5-label for="fail-status" show-colon>HTTP status</ui5-label>
						<ui5-input
							id="fail-status"
							type="Number"
							value={String(failStatus)}
							oninput={typed((v) => (failStatus = Number(v)))}
						></ui5-input>
						<ui5-label for="fail-message" show-colon>Message</ui5-label>
						<ui5-input
							id="fail-message"
							value={failMessage}
							oninput={typed((v) => (failMessage = v))}
						></ui5-input>
					{:else}
						<ui5-label for="slow-seconds" show-colon>After seconds</ui5-label>
						<ui5-input
							id="slow-seconds"
							type="Number"
							value={String(slowSeconds)}
							oninput={typed((v) => (slowSeconds = Number(v)))}
						></ui5-input>
					{/if}
					<span></span>
					<div class="row">
						<ui5-button
							design="Emphasized"
							disabled={busy || !chosenAnswerService || undefined}
							onclick={() => {
								const service = chosenAnswerService;
								if (service)
									void run(() => setOdataServiceAnswer({ service, answer: answerToSet() }));
							}}
						>
							Set
						</ui5-button>
					</div>
				</div>
				{#each answers as [service, answer] (service)}
					<div class="line">
						<span class="name">{service}</span>
						<span class="muted">{describeAnswer(answer)}</span>
						<span class="spacer"></span>
						<ui5-button
							design="Transparent"
							disabled={busy || undefined}
							onclick={() => run(() => setOdataServiceAnswer({ service, answer: null }))}
						>
							Back to normal
						</ui5-button>
					</div>
				{:else}
					<p class="muted">Every service answers normally.</p>
				{/each}
			</div>
		</ui5-card>

		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="Data"
				subtitle-text="What the mock holds now, written changes included"
			></ui5-card-header>
			<div class="card-body">
				<div class="form">
					<ui5-label for="data-service" show-colon>Service</ui5-label>
					<ui5-select
						id="data-service"
						onchange={select<string>((v) => {
							dataService = v;
							dataSet = '';
						})}
					>
						{#each services as service (service.name)}
							<ui5-option
								data-value={service.name}
								selected={service.name === chosenDataService || undefined}
							>
								{service.name}
							</ui5-option>
						{/each}
					</ui5-select>
				</div>
				<div class="row">
					<ui5-button
						icon="refresh"
						design="Transparent"
						disabled={busy || undefined}
						onclick={() => run(refreshData)}
					>
						Refresh
					</ui5-button>
					<ui5-button
						icon="reset"
						design="Transparent"
						disabled={busy || undefined}
						onclick={reset}
					>
						Reset to the files
					</ui5-button>
				</div>
				{#if sets?.error}
					<ui5-message-strip design="Negative" hide-close-button>
						{errorMessage(sets.error)}
					</ui5-message-strip>
				{:else if sets?.current}
					<div class="sets">
						{#each sets.current as set (set.name)}
							<button
								type="button"
								class={['set', set.name === dataSet && 'selected']}
								aria-pressed={set.name === dataSet}
								onclick={() => (dataSet = set.name === dataSet ? '' : set.name)}
							>
								<span>{set.name}</span>
								<span class="muted">{set.count}</span>
							</button>
						{/each}
					</div>
				{:else if sets}
					<ui5-busy-indicator active></ui5-busy-indicator>
				{/if}
			</div>
		</ui5-card>
	</div>

	{#if rows}
		<ui5-card class="block">
			<ui5-card-header slot="header" title-text={dataSet} subtitle-text="The first {ROWS} entries"
			></ui5-card-header>
			<div class="card-body">
				{#if rows.error}
					<ui5-message-strip design="Negative" hide-close-button>
						{errorMessage(rows.error)}
					</ui5-message-strip>
				{:else if !rows.current}
					<ui5-busy-indicator active></ui5-busy-indicator>
				{:else}
					{@const page = rows.current}
					{#if page.rows.length}
						<div class="table-scroll">
							<table aria-label="Entries of {dataSet}">
								<thead>
									<tr>
										{#each columns as column (column)}<th scope="col">{column}</th>{/each}
									</tr>
								</thead>
								<tbody>
									<!-- Keyed by position: rows have keys of their own, but which fields form them differs per set. -->
									{#each page.rows as row, i (i)}
										<tr>
											{#each columns as column (column)}<td>{cell(row[column])}</td>{/each}
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						{#if page.count > page.rows.length}
							<p class="muted">{page.count - page.rows.length} more not shown.</p>
						{/if}
					{:else}
						<p class="muted">No entries.</p>
					{/if}
				{/if}
			</div>
		</ui5-card>
	{/if}

	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Requests"
			subtitle-text="Newest first, once answered. Select one to see what was sent and answered."
		></ui5-card-header>
		<div class="card-body">
			{#if requests.length}
				<div class="row">
					<ui5-button
						icon="delete"
						design="Transparent"
						disabled={busy || undefined}
						onclick={() => run(() => clearOdataLog())}
					>
						Clear the list
					</ui5-button>
				</div>
			{/if}
			<div class="scroll">
				{#each requests as request (request.seq)}
					{@const result = outcome(request)}
					<button
						type="button"
						class={['request', request.seq === selected && 'selected']}
						aria-pressed={request.seq === selected}
						onclick={() => (selected = request.seq === selected ? null : request.seq)}
					>
						<span class="muted mono">{time(request.at)}</span>
						<span class="method mono">{request.method}</span>
						<span class="name">{request.service ?? 'no service'}</span>
						<span class="mono path">{shortUrl(request)}</span>
						<ui5-tag design={result.design}>{result.text}</ui5-tag>
						{#if request.answer !== 'normal'}
							<ui5-tag design="Critical">
								{request.answer === 'fail' ? 'Failed as set' : 'Late as set'}
							</ui5-tag>
						{/if}
						<span class="muted">{request.durationMs} ms</span>
					</button>
				{:else}
					<span class="muted">
						No requests yet. They appear here as soon as a test or an app calls the mock.
					</span>
				{/each}
			</div>
		</div>
	</ui5-card>

	{#if open}
		<ui5-card class="block">
			<ui5-card-header
				slot="header"
				title-text="{open.method} {shortUrl(open)}"
				subtitle-text="{open.service ?? 'No service'} · {new Date(open.at).toLocaleString()}"
			></ui5-card-header>
			<div class="card-body">
				{#await getOdataRequest(open.seq)}
					<ui5-busy-indicator active></ui5-busy-indicator>
				{:then full}
					<p class="mono muted url">{full.url}</p>
					<div class="bodies">
						<section>
							<ui5-title level="H5">Sent</ui5-title>
							{#if full.requestBody}
								{#if view.technical && full.requestType}<p class="muted mono">
										{full.requestType}
									</p>{/if}
								<pre class="raw">{pretty(full.requestBody, full.requestType)}</pre>
								{#if full.requestBodyCut}<p class="muted">Cut off after 16 KB.</p>{/if}
							{:else}
								<p class="muted">No body.</p>
							{/if}
						</section>
						<section>
							<ui5-title level="H5">Answered</ui5-title>
							{#if full.responseBody}
								{#if view.technical && full.responseType}<p class="muted mono">
										{full.responseType}
									</p>{/if}
								<pre class="raw">{pretty(full.responseBody, full.responseType)}</pre>
								{#if full.responseBodyCut}<p class="muted">Cut off after 16 KB.</p>{/if}
							{:else}
								<p class="muted">No body.</p>
							{/if}
						</section>
					</div>
				{:catch e}
					<ui5-message-strip design="Negative" hide-close-button>
						{errorMessage(e)}
					</ui5-message-strip>
				{/await}
			</div>
		</ui5-card>
	{/if}
{/if}

<style>
	.intro {
		margin: 0 0 1rem;
		max-width: 50rem;
	}
	.start {
		max-width: 40rem;
	}
	.start p {
		margin: 0 0 0.75rem;
	}
	.block {
		display: block;
		margin-bottom: 1rem;
	}
	.form {
		display: grid;
		grid-template-columns: max-content 1fr;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}
	.form p {
		margin: 0;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		min-height: 2.25rem;
	}
	.line .spacer {
		flex: 1;
	}
	.switch {
		margin-top: 0.5rem;
	}
	.name {
		font-weight: bold;
		min-width: 4rem;
	}
	.scroll {
		max-height: 24rem;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.sets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.5rem;
	}
	.request,
	.set {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.35rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.set {
		gap: 0.4rem;
		border-color: var(--sapList_BorderColor);
	}
	.request:hover,
	.set:hover {
		background: var(--sapList_Hover_Background);
	}
	.request.selected,
	.set.selected {
		background: var(--sapList_SelectionBackgroundColor);
		border-color: var(--sapList_SelectionBorderColor);
	}
	.method {
		min-width: 3.5rem;
	}
	.path {
		word-break: break-all;
	}
	.url {
		word-break: break-all;
		margin: 0 0 0.75rem;
	}
	.table-scroll {
		max-height: 28rem;
		overflow: auto;
	}
	table {
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	th,
	td {
		padding: 0.3rem 0.6rem;
		border-bottom: 1px solid var(--sapList_BorderColor);
		text-align: left;
		white-space: nowrap;
	}
	th {
		position: sticky;
		top: 0;
		background: var(--sapList_HeaderBackground);
	}
	.bodies {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
	}
	.raw {
		max-height: 24rem;
		overflow: auto;
		font-size: 0.85em;
		white-space: pre-wrap;
		word-break: break-all;
	}
</style>
