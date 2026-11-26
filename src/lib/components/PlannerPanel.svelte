<script lang="ts">
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { duration, when } from '#lib/shared/format.js';
	import {
		getPlanner,
		getPlanning,
		startPlanner,
		stopPlanner
	} from '#lib/remote/planner.remote.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';

	/**
	 * The planner: describe a business process, and the AI explores the application in a browser of
	 * its own and writes a test plan to sap-tests/specs for a person to review. It writes no code.
	 */
	const planner = getPlanner();
	const env = getEnvStatus();

	/** Without sign-in: an application anyone can open, given by its address. */
	const NO_SIGN_IN = '';
	const systems = $derived(env.current?.systems ?? []);
	let system = $state(NO_SIGN_IN);
	let address = $state('');
	let flow = $state('');
	let error = $state<string | null>(null);

	/** The session shown: the one picked, else the one at work, else the newest. */
	let picked = $state<string | null>(null);
	const shown = $derived(
		picked ?? planner.current?.active ?? planner.current?.sessions[0]?.id ?? null
	);
	const planning = $derived(shown ? getPlanning(shown) : null);
	const session = $derived(planning?.current?.state);
	const working = $derived(session?.status === 'running');
	const busy = $derived(!!planner.current?.active);
	const ready = $derived(!!flow.trim() && (system !== NO_SIGN_IN || !!address.trim()));

	// The session shown, while it works.
	$effect(() => {
		if (!working || !planning) return;
		const watched = planning;
		const t = setInterval(() => {
			void watched.refresh();
		}, 2000);
		return () => {
			clearInterval(t);
			void planner.refresh();
		};
	});
	// The start button and the list, while any session works: also one that is not shown.
	$effect(() => {
		if (!busy) return;
		const t = setInterval(() => {
			void planner.refresh();
		}, 3000);
		return () => {
			clearInterval(t);
		};
	});

	async function start() {
		error = null;
		try {
			const { id } = await startPlanner({
				...(system === NO_SIGN_IN ? {} : { system }),
				...(address.trim() ? { address: address.trim() } : {}),
				flow
			});
			picked = id;
		} catch (e) {
			error = errorMessage(e);
		}
	}
	async function stop() {
		if (!session) return;
		try {
			await stopPlanner(session.id);
		} catch (e) {
			error = errorMessage(e);
		}
	}

	const elapsed = $derived(
		session
			? Date.parse(session.finishedAt ?? new Date().toISOString()) - Date.parse(session.startedAt)
			: 0
	);
	const statusText = {
		running: 'working',
		finished: 'finished',
		failed: 'did not finish',
		stopped: 'stopped'
	};
</script>

<ui5-message-strip design="Information" hide-close-button>
	Describe a business process, and the AI planner clicks through the application in a browser of its
	own and writes a test plan: the scenarios, their steps and what to check. It writes no test code.
	You read the plan and correct it before a test is written from it.
	{#if view.technical}
		The planner is the agent of <span class="mono">.claude/agents/playwright-test-planner.md</span>;
		its plans go to <span class="mono">sap-tests/specs</span>.
	{/if}
</ui5-message-strip>

{#if planner.current?.problem}
	<ui5-message-strip design="Critical" hide-close-button>
		{planner.current.problem}
	</ui5-message-strip>
{/if}

<ui5-card class="form-card">
	<div class="form">
		<ui5-label for="plan-system" show-colon>Application</ui5-label>
		<ui5-select
			id="plan-system"
			onchange={(e: CustomEvent<{ selectedOption: HTMLElement }>) =>
				(system = e.detail.selectedOption.dataset.value ?? NO_SIGN_IN)}
		>
			<ui5-option data-value={NO_SIGN_IN} selected={system === NO_SIGN_IN || undefined}>
				A page without sign-in
			</ui5-option>
			{#each systems as s (s.id)}
				<ui5-option data-value={s.id} selected={system === s.id || undefined}>
					{s.title} (signed in)
				</ui5-option>
			{/each}
		</ui5-select>

		<ui5-label for="plan-address" show-colon required={system === NO_SIGN_IN || undefined}>
			Address
		</ui5-label>
		<ui5-input
			id="plan-address"
			value={address}
			placeholder={system === NO_SIGN_IN
				? 'https://…'
				: 'Optional: the page of the system to start from'}
			oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
				(address = e.currentTarget.value)}
		></ui5-input>

		<ui5-label for="plan-flow" show-colon required>Business process</ui5-label>
		<ui5-textarea
			id="plan-flow"
			value={flow}
			rows="4"
			maxlength="4000"
			placeholder="For example: add a product to the cart, change its quantity and check out as a guest"
			oninput={(e: Event & { currentTarget: HTMLTextAreaElement }) =>
				(flow = e.currentTarget.value)}
		></ui5-textarea>

		<span></span>
		<div class="row">
			<ui5-button
				design="Emphasized"
				icon="ai"
				onclick={start}
				disabled={!ready || busy || !!planner.current?.problem || undefined}
			>
				Plan the tests
			</ui5-button>
			{#if busy}<span class="muted">The planner is working.</span>{/if}
		</div>
	</div>
</ui5-card>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}

{#if session}
	<ui5-card class="session">
		<div class="body">
			<div class="row">
				<ui5-title level="H5">{session.target}</ui5-title>
				{#if working}
					<ui5-busy-indicator active size="S"></ui5-busy-indicator>
					<span class="muted">working · {duration(elapsed)}</span>
					<span class="spacer"></span>
					<ui5-button design="Transparent" icon="stop" onclick={stop}>Stop the planner</ui5-button>
				{:else}
					<span class="muted">
						{statusText[session.status]} after {duration(elapsed)}{session.costUsd !== undefined
							? ` · about $${session.costUsd.toFixed(2)}`
							: ''}
					</span>
				{/if}
			</div>
			<p class="flow">{session.flow}</p>

			{#if session.error}
				<ui5-message-strip design="Negative" hide-close-button>{session.error}</ui5-message-strip>
			{/if}

			{#if session.report}
				<pre class="report">{session.report}</pre>
			{/if}

			{#if session.plan && !working}
				{#if planning?.current?.plan}
					<ui5-message-strip design="Critical" hide-close-button>
						The plan is saved as <span class="mono">{session.plan}</span>. Nothing is committed and
						no test exists yet: read it, correct what is wrong or missing, and only then have tests
						written from it.
					</ui5-message-strip>
					<details open>
						<summary class="mono">{session.plan}</summary>
						<pre class="plan">{planning.current.plan}</pre>
					</details>
				{:else}
					<ui5-message-strip design="Information" hide-close-button>
						The plan <span class="mono">{session.plan}</span> is no longer there.
					</ui5-message-strip>
				{/if}
			{/if}

			{#if session.activity.length}
				<details open={working || undefined}>
					<summary>What the planner did ({session.activity.length} steps)</summary>
					<ol class="activity">
						{#each session.activity as line, n (n)}<li>{line}</li>{/each}
					</ol>
				</details>
			{/if}
		</div>
	</ui5-card>
{/if}

{#if (planner.current?.sessions.length ?? 0) > 1}
	<ui5-title level="H5">Earlier plans</ui5-title>
	<ul class="sessions">
		{#each planner.current?.sessions ?? [] as s (s.id)}
			<li>
				<button
					type="button"
					class="link"
					aria-current={s.id === shown || undefined}
					onclick={() => (picked = s.id)}
				>
					{when(s.startedAt)} · {s.target}
				</button>
				<span class="muted">{statusText[s.status]}{s.plan ? ` · ${s.plan}` : ''}</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.form-card,
	.session {
		max-width: 60rem;
		margin-bottom: 1rem;
	}
	.form {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.75rem 1rem;
		align-items: center;
		padding: 1rem;
	}
	.form ui5-input,
	.form ui5-textarea {
		width: 100%;
	}
	.form ui5-select {
		justify-self: start;
		min-width: 16rem;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.flow {
		margin: 0;
		white-space: pre-wrap;
	}
	.report,
	.plan {
		white-space: pre-wrap;
		margin: 0;
		padding: 0.75rem;
		border: 1px solid var(--sapGroup_ContentBorderColor);
		border-radius: 0.5rem;
		font-family: var(--sapFontFamily);
		font-size: var(--sapFontSize);
	}
	.plan {
		font-family: var(--sapFontFamilyMonospace, monospace);
		font-size: 0.8125rem;
		max-height: 40rem;
		overflow: auto;
	}
	.activity {
		margin: 0;
		padding-left: 1.5rem;
		font-size: 0.8125rem;
	}
	summary {
		cursor: pointer;
		color: var(--sapLinkColor);
	}
	.sessions {
		margin: 0.5rem 0 0;
		padding-left: 1.25rem;
	}
	.link {
		border: 0;
		padding: 0;
		background: none;
		color: var(--sapLinkColor);
		font: inherit;
		cursor: pointer;
	}
	.link[aria-current] {
		font-weight: bold;
	}
	@media (max-width: 600px) {
		.form {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
		}
	}
</style>
