<script lang="ts">
	import IdocSegments from '#lib/components/idoc/IdocSegments.svelte';
	import { settingsHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import {
		clearIdocInbox,
		clearSentIdocs,
		getIdocSamples,
		getRawIdoc,
		sendIdocSample,
		sendIdocSampleToSap,
		setIdocReply,
		startIdocReceiver,
		stopIdocReceiver,
		watchIdocLive
	} from '#lib/remote/idoc.remote.js';
	import type { IdocReply, IdocSapSystem, ReceivedIdoc, SentIdocs } from '#lib/shared/idoc.js';

	const live = watchIdocLive();
	const samples = getIdocSamples();
	const snap = $derived(live.current);
	const status = $derived(snap?.status);

	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	/** The IDoc opened below the list. */
	let selected = $state<number | null>(null);
	let showRaw = $state(false);

	let samplePartner = $state('PWMOCK');
	let sample = $state('');
	let sapSample = $state('');
	let sapTo = $state<IdocSapSystem | ''>('');

	let replyPartner = $state('PWMOCK');
	let replyMode = $state<IdocReply['mode']>('reject');
	let rejectStatus = $state(500);
	let rejectMessage = $state('Rejected by the IDoc mock');
	let slowSeconds = $state(30);

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

	const idocs = $derived((snap?.idocs ?? []).toReversed());
	const open = $derived(idocs.find((idoc) => idoc.seq === selected));
	/** Samples SAP would send; the inbound ones go the other way, into SAP. */
	const outboundSamples = $derived(
		(samples.current ?? []).filter((s) => !s.name.includes('inbound'))
	);
	const chosenSample = $derived(
		outboundSamples.find((s) => s.name === sample) ?? outboundSamples[0]
	);
	const replies = $derived(Object.entries(snap?.replies ?? {}));
	/** The sample to send into SAP: the one chosen, otherwise the first inbound one. An outbound one is refused
	 * before it goes out. */
	const chosenSapSample = $derived(
		(samples.current ?? []).find((s) => s.name === sapSample) ??
			(samples.current ?? []).find((s) => s.name.includes('inbound')) ??
			samples.current?.[0]
	);
	/** The SAP system to send into: the one chosen, otherwise the first one set (S/4HANA before EWM). */
	const target = $derived((snap?.sap ?? []).find((t) => t.system === sapTo) ?? snap?.sap[0]);
	const sent = $derived((snap?.sent ?? []).toReversed());
	const systemTitle = (system: IdocSapSystem) =>
		snap?.sap.find((t) => t.system === system)?.title ?? system;

	const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });
	const kind = ({ idoc: { control } }: ReceivedIdoc) =>
		[control.CIMTYP || control.IDOCTYP, control.MESTYP].filter(Boolean).join(' · ') || '?';

	/** What SAP made of the receiver's answer. */
	const outcome = (idoc: ReceivedIdoc) => {
		if (!idoc.answered) return { text: 'Answer pending', design: 'Information' } as const;
		if (idoc.accepted)
			return {
				text: idoc.reply === 'slow' ? 'Accepted late' : 'Accepted',
				design: 'Positive'
			} as const;
		return idoc.reply === 'slow'
			? ({ text: 'SAP gave up waiting', design: 'Critical' } as const)
			: ({ text: 'Rejected', design: 'Negative' } as const);
	};

	const sentKind = ({ idocs: [first] }: SentIdocs) =>
		first
			? [first.control.CIMTYP || first.control.IDOCTYP, first.control.MESTYP]
					.filter(Boolean)
					.join(' · ') || '?'
			: '?';

	/** What SAP answered to a send, in a few words. */
	const sentOutcome = ({ result, standIn }: SentIdocs) =>
		result.ok
			? ({ text: standIn ? 'Taken by the stand-in' : 'Taken by SAP', design: 'Positive' } as const)
			: result.status === 0
				? ({ text: 'SAP not reached', design: 'Critical' } as const)
				: ({ text: `Refused (HTTP ${result.status})`, design: 'Negative' } as const);

	const describeReply = (reply: IdocReply) =>
		reply.mode === 'reject'
			? `Rejected with HTTP ${reply.status}: ${reply.message}`
			: reply.mode === 'slow'
				? `Answered after ${reply.delayMs / 1000} s`
				: 'Accepted';

	const MODE_HELP = {
		reject: 'SAP gets an HTTP error and sets an error status on the IDoc.',
		slow: "The answer comes after the delay, to test SAP's timeout.",
		accept: 'SAP gets HTTP 200 and sets status 03 (sent).'
	} as const;

	const LOGIN = {
		none: 'none',
		user: 'user and password',
		certificate: "SAP's client certificate",
		'user-and-certificate': "user and password, and SAP's client certificate"
	} as const;

	/** How the receiver logs on to SAP. */
	const LOGIN_TO_SAP = {
		none: 'none',
		user: 'user and password',
		certificate: 'client certificate',
		'user-and-certificate': 'user and password, and client certificate'
	} as const;

	/** Control record fields worth showing without technical details. */
	const CONTROL_SHOWN = [
		['MESTYP', 'Message type'],
		['IDOCTYP', 'IDoc type'],
		['CIMTYP', 'Extension'],
		['SNDPRN', 'Sent by'],
		['RCVPRN', 'Sent to'],
		['DOCNUM', 'IDoc number in SAP']
	] as const;

	async function sendSample() {
		const name = chosenSample?.name;
		if (!name) return;
		await run(async () => {
			const answer = await sendIdocSample({ name, partner: samplePartner });
			const plain =
				answer.status < 300
					? 'The receiver accepted the IDoc.'
					: `The receiver refused the IDoc (HTTP ${answer.status}): ${answer.reason ?? ''}`;
			notice = view.technical ? `${plain} It answered: ${answer.body}` : plain;
		});
	}

	async function sendToSap() {
		const name = chosenSapSample?.name;
		const to = target;
		if (!name || !to) return;
		await run(async () => {
			const { result } = await sendIdocSampleToSap({ name, to: to.system });
			const numbers = result.idocNumbers.join(', ');
			const into = to.standIn ? `The stand-in for ${to.title}` : to.title;
			notice = result.ok
				? `${into} took the IDoc${numbers ? `: IDoc number ${numbers}` : ''}.`
				: `${into} did not take the IDoc: ${result.reason ?? `HTTP ${result.status}`}`;
		});
	}

	function replyToSet(): IdocReply {
		if (replyMode === 'reject')
			return { mode: 'reject', status: rejectStatus, message: rejectMessage };
		if (replyMode === 'slow') return { mode: 'slow', delayMs: Math.round(slowSeconds * 1000) };
		return { mode: 'accept' };
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Mock IDoc</ui5-title>
	{#if status?.running}
		<ui5-tag design="Information">
			{status.external ? 'Running on the server' : 'Receiving'}
		</ui5-tag>
	{:else if status}
		<ui5-tag design="Neutral">Stopped</ui5-tag>
	{/if}
	<span class="spacer"></span>
	{#if status?.running && !status.external}
		<ui5-button
			icon="stop"
			disabled={busy || undefined}
			onclick={() => run(() => stopIdocReceiver())}
		>
			Stop
		</ui5-button>
	{/if}
</div>

<p class="muted intro">
	Stands in for the partner system SAP sends IDocs to. It keeps every IDoc SAP sends, so a test can
	check what a business step produced, and it can refuse IDocs or answer late, to test how SAP
	handles a partner that is down. It can also send IDocs into S/4HANA or EWM over HTTPS, the way SAP
	Cloud Integration does.
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
		<ui5-card-header slot="header" title-text="Start the IDoc receiver"></ui5-card-header>
		<div class="card-body">
			<p class="muted">
				It listens on this computer. For SAP to reach it, it needs HTTPS and a login, set in the
				app's environment.
			</p>
			{#if view.technical}
				<p class="muted mono">
					IDOC_HOST, IDOC_PORT, IDOC_TLS_CERT, IDOC_TLS_KEY, IDOC_USER and IDOC_PASSWORD (or
					IDOC_TLS_CA with IDOC_TLS_CLIENT_FINGERPRINT); see sap-tests/idoc/README.md.
				</p>
			{/if}
			<div class="row">
				<ui5-button
					design="Emphasized"
					icon="play"
					disabled={busy || undefined}
					onclick={() => run(() => startIdocReceiver())}
				>
					Start
				</ui5-button>
			</div>
		</div>
	</ui5-card>
{:else}
	{#if snap.endpoint}
		<ui5-card class="block">
			<ui5-card-header
				slot="header"
				title-text="Where SAP sends IDocs"
				subtitle-text="Set this up in SAP once per partner"
			></ui5-card-header>
			<div class="card-body">
				<div class="line">
					<span class="mono address">{snap.endpoint.url}/idoc/&lt;partner&gt;</span>
				</div>
				{#if !status.external}
					<div class="line">
						<span class="muted">Login: {LOGIN[snap.endpoint.login]}</span>
					</div>
				{/if}
				{#if !snap.endpoint.https}
					<ui5-message-strip design="Critical" hide-close-button>
						Without HTTPS only this computer can send to it, so SAP can't reach it yet. Tests and
						the samples below work.
					</ui5-message-strip>
				{/if}
				{#if view.technical}
					<ol class="steps muted">
						<li>
							SM59: a type G destination to this host and port, path prefix
							<span class="mono">/idoc/&lt;partner&gt;</span>, with SSL and the receiver's CA in
							STRUST.
						</li>
						<li>WE21: an XML HTTP port using that destination, with or without "SOAP Protocol".</li>
						<li>WE20: the partner profile with outbound parameters for the message types.</li>
					</ol>
				{/if}
			</div>
		</ui5-card>
	{/if}

	<div class="grid">
		{#if snap.canSendSamples}
			<ui5-card>
				<ui5-card-header
					slot="header"
					title-text="Try it without SAP"
					subtitle-text="Send a sample IDoc, as SAP would"
				></ui5-card-header>
				<div class="card-body form">
					<ui5-label for="sample-partner" show-colon>Partner</ui5-label>
					<ui5-input
						id="sample-partner"
						value={samplePartner}
						oninput={typed((v) => (samplePartner = v))}
					></ui5-input>
					<ui5-label for="sample" show-colon>Sample</ui5-label>
					<ui5-select id="sample" onchange={select<string>((v) => (sample = v))}>
						{#each outboundSamples as option (option.name)}
							<ui5-option
								data-value={option.name}
								selected={option.name === chosenSample?.name || undefined}
							>
								{option.name}
							</ui5-option>
						{/each}
					</ui5-select>
					{#if chosenSample?.description}
						<span></span>
						<p class="muted">{chosenSample.description}</p>
					{/if}
					<span></span>
					<div class="row">
						<ui5-button
							design="Emphasized"
							icon="paper-plane"
							disabled={busy || !chosenSample || undefined}
							onclick={sendSample}
						>
							Send
						</ui5-button>
					</div>
				</div>
			</ui5-card>
		{/if}

		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="Answers to SAP"
				subtitle-text="Refuse a partner's IDocs or answer late, to see how SAP reacts"
			></ui5-card-header>
			<div class="card-body">
				<div class="form">
					<ui5-label for="reply-partner" show-colon>Partner</ui5-label>
					<ui5-input
						id="reply-partner"
						value={replyPartner}
						oninput={typed((v) => (replyPartner = v))}
					></ui5-input>
					<ui5-label for="reply-mode" show-colon>Answer</ui5-label>
					<ui5-select id="reply-mode" onchange={select<IdocReply['mode']>((v) => (replyMode = v))}>
						<ui5-option data-value="reject" selected={replyMode === 'reject' || undefined}>
							Refuse
						</ui5-option>
						<ui5-option data-value="slow" selected={replyMode === 'slow' || undefined}>
							Answer late
						</ui5-option>
						<ui5-option data-value="accept" selected={replyMode === 'accept' || undefined}>
							Accept
						</ui5-option>
					</ui5-select>
					<span></span>
					<p class="muted">{MODE_HELP[replyMode]}</p>
					{#if replyMode === 'reject'}
						<ui5-label for="reject-status" show-colon>HTTP status</ui5-label>
						<ui5-input
							id="reject-status"
							type="Number"
							value={String(rejectStatus)}
							oninput={typed((v) => (rejectStatus = Number(v)))}
						></ui5-input>
						<ui5-label for="reject-message" show-colon>Message</ui5-label>
						<ui5-input
							id="reject-message"
							value={rejectMessage}
							oninput={typed((v) => (rejectMessage = v))}
						></ui5-input>
					{:else if replyMode === 'slow'}
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
							disabled={busy || undefined}
							onclick={() =>
								run(() => setIdocReply({ partner: replyPartner, reply: replyToSet() }))}
						>
							Set
						</ui5-button>
					</div>
				</div>
				{#each replies as [partner, reply] (partner)}
					<div class="line">
						<span class="name">{partner}</span>
						<span class="muted">{describeReply(reply)}</span>
						<span class="spacer"></span>
						{#if reply.setBy === 'test'}
							<!-- A running test's reply: the page can't take it back, the test does when it ends. -->
							<ui5-tag design="Neutral">Set by a running test</ui5-tag>
						{:else}
							<ui5-button
								design="Transparent"
								disabled={busy || undefined}
								onclick={() => run(() => setIdocReply({ partner, reply: null }))}
							>
								Back to accept
							</ui5-button>
						{/if}
					</div>
				{:else}
					<p class="muted">Every partner's IDocs are accepted.</p>
				{/each}
			</div>
		</ui5-card>
	</div>

	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Send IDocs into SAP"
			subtitle-text="Into S/4HANA or EWM, as SAP Cloud Integration would"
		></ui5-card-header>
		<div class="card-body">
			{#if target}
				<div class="form">
					<ui5-label for="sap-to" show-colon>To</ui5-label>
					<ui5-select id="sap-to" onchange={select<IdocSapSystem>((v) => (sapTo = v))}>
						{#each snap.sap as option (option.system)}
							<ui5-option
								data-value={option.system}
								selected={option.system === target.system || undefined}
							>
								{option.title}{option.standIn ? ' (stand-in)' : ''}
							</ui5-option>
						{/each}
					</ui5-select>
					<span></span>
					<div class="line">
						{#if target.standIn}
							<ui5-tag design="Critical">Stand-in, not SAP</ui5-tag>
						{:else}
							<span class="mono">{target.url}</span>
							{#if target.client}<span class="muted">client {target.client}</span>{/if}
						{/if}
					</div>
					{#if target.standIn}
						<span></span>
						<p class="muted">
							No address is set for {target.title}, so a stand-in in the receiver takes the IDocs
							and numbers them, for trying this out. SAP never sees them. To send into {target.title},
							set it on the <a href={settingsHref()}>Settings page</a> and start the receiver again.
						</p>
					{/if}
					{#if view.technical}
						<span></span>
						<span class="muted mono">
							{target.standIn ? target.url : ''}
							{target.service === 'soap' ? '/sap/bc/srt/idoc (SOAP)' : '/sap/bc/idoc_xml'}
							· login: {LOGIN_TO_SAP[target.login]}
						</span>
					{/if}
					<ui5-label for="sap-sample" show-colon>Sample</ui5-label>
					<ui5-select id="sap-sample" onchange={select<string>((v) => (sapSample = v))}>
						{#each samples.current ?? [] as option (option.name)}
							<ui5-option
								data-value={option.name}
								selected={option.name === chosenSapSample?.name || undefined}
							>
								{option.name}
							</ui5-option>
						{/each}
					</ui5-select>
					{#if chosenSapSample?.description}
						<span></span>
						<p class="muted">{chosenSapSample.description}</p>
					{/if}
					<span></span>
					<div class="row">
						<ui5-button
							design="Emphasized"
							icon="paper-plane"
							disabled={busy || !chosenSapSample || undefined}
							onclick={sendToSap}
						>
							Send to {target.title}
						</ui5-button>
						{#if sent.length}
							<ui5-button
								icon="delete"
								design="Transparent"
								disabled={busy || undefined}
								onclick={() => run(() => clearSentIdocs())}
							>
								Clear the list
							</ui5-button>
						{/if}
					</div>
				</div>
				<div class="scroll">
					{#each sent as entry (entry.seq)}
						{@const result = sentOutcome(entry)}
						<div class="line">
							<span class="muted mono">{time(entry.sentAt)}</span>
							<span>{systemTitle(entry.to)}</span>
							<span>{sentKind(entry)}</span>
							<ui5-tag design={result.design}>{result.text}</ui5-tag>
							{#if entry.result.idocNumbers.length}
								<span class="mono">{entry.result.idocNumbers.join(', ')}</span>
							{/if}
							{#if entry.by === 'test'}<span class="muted">by a test</span>{/if}
							{#if !entry.result.ok && entry.result.reason}
								<span class="muted">{entry.result.reason}</span>
							{/if}
						</div>
					{:else}
						<span class="muted">Nothing sent yet.</span>
					{/each}
				</div>
			{:else}
				<p class="muted">
					No SAP system is set for the receiver, so it only receives. Set S/4HANA or EWM on the
					<a href={settingsHref()}>Settings page</a> and start the receiver again.
				</p>
				{#if view.technical}
					<p class="muted mono">
						IDOC_S4_URL or IDOC_EWM_URL, with a client, user and password; IDOC_FAKE_SAP=0 turns the
						stand-ins off. See sap-tests/idoc/README.md.
					</p>
				{/if}
			{/if}
		</div>
	</ui5-card>

	<ui5-card class="block">
		<ui5-card-header
			slot="header"
			title-text="Received IDocs"
			subtitle-text="Newest first. Select one to see its segments."
		></ui5-card-header>
		<div class="card-body">
			{#if idocs.length}
				<div class="row">
					<ui5-button
						icon="delete"
						design="Transparent"
						disabled={busy || undefined}
						onclick={() => run(() => clearIdocInbox())}
					>
						Clear the list
					</ui5-button>
				</div>
			{/if}
			<div class="scroll">
				{#each idocs as idoc (idoc.seq)}
					{@const result = outcome(idoc)}
					<button
						type="button"
						class={['idoc', idoc.seq === selected && 'selected']}
						aria-pressed={idoc.seq === selected}
						onclick={() => {
							selected = idoc.seq === selected ? null : idoc.seq;
							showRaw = false;
						}}
					>
						<span class="muted mono">{time(idoc.receivedAt)}</span>
						<span class="name">{idoc.partner}</span>
						<span>{kind(idoc)}</span>
						<ui5-tag design={result.design}>{result.text}</ui5-tag>
						{#if view.technical}
							<span class="muted mono">
								#{idoc.seq}{idoc.soap ? ' · SOAP' : ''}{idoc.idoc.control.DOCNUM
									? ` · ${idoc.idoc.control.DOCNUM}`
									: ''}
							</span>
						{/if}
					</button>
				{:else}
					<span class="muted">No IDocs yet. They appear here as soon as SAP sends one.</span>
				{/each}
			</div>
		</div>
	</ui5-card>

	{#if open}
		<ui5-card class="block">
			<ui5-card-header
				slot="header"
				title-text="{kind(open)} for {open.partner}"
				subtitle-text="Received {new Date(open.receivedAt).toLocaleString()}"
			></ui5-card-header>
			<div class="card-body">
				<dl class="control">
					{#each CONTROL_SHOWN as [field, label] (field)}
						{#if open.idoc.control[field]}
							<dt class="muted">{label}</dt>
							<dd class="mono">{open.idoc.control[field]}</dd>
						{/if}
					{/each}
				</dl>
				{#if view.technical}
					<p class="mono muted control-all">
						{Object.entries(open.idoc.control)
							.map(([name, value]) => `${name}=${value}`)
							.join(' ')}
					</p>
				{/if}
				<IdocSegments segments={open.idoc.segments} />
				{#if view.technical}
					<div class="row">
						<ui5-button design="Transparent" onclick={() => (showRaw = !showRaw)}>
							{showRaw ? 'Hide the request' : 'Show the request as SAP sent it'}
						</ui5-button>
					</div>
					{#if showRaw}
						{#await getRawIdoc(open.seq)}
							<ui5-busy-indicator active></ui5-busy-indicator>
						{:then raw}
							<pre class="raw">{raw.text}</pre>
							{#if raw.cut}<p class="muted">Cut off after 2 MB.</p>{/if}
						{:catch e}
							<ui5-message-strip design="Negative" hide-close-button>
								{errorMessage(e)}
							</ui5-message-strip>
						{/await}
					{/if}
				{/if}
			</div>
		</ui5-card>
	{/if}

	{#if snap.failures.length}
		<ui5-card class="block">
			<ui5-card-header
				slot="header"
				title-text="Refused requests"
				subtitle-text="Requests that weren't IDocs, or came without the right login. Newest first."
			></ui5-card-header>
			<div class="card-body scroll">
				<!-- Keyed by position: refused requests have no id, and two can be alike; the list is only shown. -->
				{#each snap.failures.toReversed() as failure, i (i)}
					<div class="line">
						<span class="muted mono">{time(failure.at)}</span>
						<span class="name">{failure.partner || '?'}</span>
						<ui5-tag design="Negative">{failure.status}</ui5-tag>
						<span>{failure.error}</span>
					</div>
				{/each}
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
	.name {
		font-weight: bold;
		min-width: 4rem;
	}
	.address {
		font-size: 1.1em;
	}
	.steps {
		margin: 0.5rem 0 0;
		padding-left: 1.25rem;
	}
	.scroll {
		max-height: 24rem;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.idoc {
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
	.idoc:hover {
		background: var(--sapList_Hover_Background);
	}
	.idoc.selected {
		background: var(--sapList_SelectionBackgroundColor);
		border-color: var(--sapList_SelectionBorderColor);
	}
	.control {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.75rem;
	}
	.control dd {
		margin: 0;
	}
	.control-all {
		word-break: break-all;
	}
	.raw {
		max-height: 24rem;
		overflow: auto;
		font-size: 0.85em;
		white-space: pre-wrap;
		word-break: break-all;
	}
</style>
