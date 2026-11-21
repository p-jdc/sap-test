<script lang="ts">
	import HistoryDots from '#lib/components/HistoryDots.svelte';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { flowHref, recorderHref, runHref, settingsHref, testsHref } from '#lib/client/links.js';
	import { runAndOpen } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { duration, SURFACE_LABEL, when } from '#lib/shared/format.js';
	import { getEnvStatus, getSpecs } from '#lib/remote/specs.remote.js';
	import { getRuns, getStability } from '#lib/remote/runs.remote.js';
	import type { SettingName, Surface } from '#lib/shared/types.js';

	const env = getEnvStatus();
	const specs = getSpecs();
	const runs = getRuns();
	const stab = getStability();

	let error = $state<string | null>(null);

	const lastRun = $derived(runs.current?.runs[0]);
	const tests = $derived(specs.current?.flatMap((f) => f.tests) ?? []);
	const bySurface = $derived(
		tests.reduce<Record<string, number>>((acc, t) => {
			acc[t.surface] = (acc[t.surface] ?? 0) + 1;
			return acc;
		}, {})
	);
	const issueCount = $derived(
		tests.reduce((n, t) => n + t.issues.filter((i) => i.severity !== 'info').length, 0)
	);
	const target = $derived(stab.current?.target ?? 10);
	const stableCount = $derived(stab.current?.rows.filter((r) => r.streak >= target).length ?? 0);

	const has = (...names: SettingName[]) =>
		names.every((n) => env.current?.vars.find((v) => v.name === n)?.set);
	const toolsReady = $derived(!!env.current?.playwrightVersion);
	const sapReady = $derived(has('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD'));
	const aribaReady = $derived(has('ARIBA_URL', 'ARIBA_USER', 'ARIBA_PASS'));
	const hasRuns = $derived((runs.current?.runs.length ?? 0) > 0);
	// The first steps stay on the page until both are done; before the data is there, nothing shows.
	const gettingStarted = $derived(!!env.current && !!runs.current && !(hasRuns && sapReady));
	const busy = $derived(!!runs.current?.active);

	async function run(files?: string[]) {
		error = await runAndOpen({ files });
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Home</ui5-title>
	<span class="spacer"></span>
	<ui5-button icon="play" design="Emphasized" onclick={() => run()} disabled={busy || undefined}>
		Run all tests
	</ui5-button>
	<ui5-button icon="lab" onclick={() => run(['_demo'])} disabled={busy || undefined}>
		Try the demo
	</ui5-button>
</div>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}
{#if runs.current?.active}
	<ui5-message-strip design="Information" hide-close-button>
		Tests are running right now. <a href={runHref(runs.current.active)}>Watch the progress</a>
	</ui5-message-strip>
{/if}

{#if gettingStarted}
	<ui5-card class="start">
		<ui5-card-header
			slot="header"
			title-text="Getting started"
			subtitle-text="A test clicks through SAP the way a person would and checks that everything works."
		></ui5-card-header>
		<ol class="steps">
			<li class:done={hasRuns}>
				<ui5-icon name={hasRuns ? 'accept' : 'lab'}></ui5-icon>
				<div>
					<strong>Try the demo</strong>
					<span class="muted">
						Three example tests that need no SAP system. One of them fails on purpose, so you see
						what a problem looks like.
					</span>
				</div>
				<ui5-button onclick={() => run(['_demo'])} disabled={busy || undefined}>
					{hasRuns ? 'Run it again' : 'Try the demo'}
				</ui5-button>
			</li>
			<li class:done={sapReady}>
				<ui5-icon name={sapReady ? 'accept' : 'action-settings'}></ui5-icon>
				<div>
					<strong>Connect your SAP test system</strong>
					<span class="muted">
						Enter its address and a test user once. Tests that need SAP are skipped until then.
					</span>
				</div>
				<a href={settingsHref()}>{sapReady ? 'Change' : 'Open Settings'}</a>
			</li>
			<li>
				<ui5-icon name="record"></ui5-icon>
				<div>
					<strong>Record your own test</strong>
					<span class="muted">
						Click through a task in SAP once; the app saves your steps as a test you can repeat.
					</span>
				</div>
				<a href={recorderHref()}>Record a test</a>
			</li>
		</ol>
	</ui5-card>
{/if}

<div class="grid">
	<ui5-card>
		<ui5-card-header
			slot="header"
			title-text="Setup"
			subtitle-text={view.technical ? (env.current?.testsDir ?? '') : 'What the tests need to run'}
		></ui5-card-header>
		<div class="card-body">
			{#if env.current}
				<div class="check">
					<span>Test tools</span>
					<StatusTag
						status={toolsReady ? 'passed' : 'failed'}
						label={toolsReady ? 'Ready' : 'Not installed'}
					/>
				</div>
				<div class="check">
					<span>SAP connection</span>
					<StatusTag
						status={sapReady ? 'passed' : 'interrupted'}
						label={sapReady ? 'Ready' : 'Not set up'}
					/>
				</div>
				<div class="check">
					<span>Ariba connection <span class="muted">(optional)</span></span>
					<StatusTag
						status={aribaReady ? 'passed' : undefined}
						label={aribaReady ? 'Ready' : 'Not set up'}
					/>
				</div>
				{#if !toolsReady}
					<span class="muted">Ask the person who installed this app to run its setup again.</span>
				{/if}
				<a href={settingsHref()}>{sapReady ? 'Change the connection' : 'Set up the connection'}</a>
				{#if view.technical}
					<div class="row">
						<StatusTag
							status={env.current.playwrightSap ? 'passed' : 'failed'}
							label={env.current.playwrightSap
								? `Playwright-SAP ${env.current.playwrightVersion}`
								: env.current.playwrightVersion
									? `Plain Playwright ${env.current.playwrightVersion}`
									: 'Playwright not installed'}
						/>
						<StatusTag
							status={env.current.node.warning ? 'interrupted' : 'passed'}
							label="Node {env.current.node.version ?? 'unknown'}"
						/>
						<StatusTag
							status={env.current.envFile ? 'passed' : 'interrupted'}
							label={env.current.envFile ? '.env found' : 'no .env'}
						/>
					</div>
					{#if env.current.node.warning}
						<ui5-message-strip design="Critical" hide-close-button>
							{env.current.node.warning}
						</ui5-message-strip>
					{/if}
					<div class="row">
						{#each env.current.vars.filter((v) => v.name !== 'CHROMIUM_PATH') as v (v.name)}
							<ui5-tag
								design={v.set ? 'Positive' : 'Neutral'}
								hide-state-icon={!v.set || undefined}
								class="mono"
							>
								{v.name}
							</ui5-tag>
						{/each}
					</div>
					<span class="muted">
						Set under Settings (system credential store) or in sap-tests/.env. Values never reach
						the browser.
					</span>
				{/if}
			{/if}
		</div>
	</ui5-card>

	<ui5-card>
		<ui5-card-header
			slot="header"
			title-text="Your tests"
			subtitle-text={view.technical
				? `${tests.length} tests in ${specs.current?.length ?? 0} files`
				: `${tests.length} tests`}
		></ui5-card-header>
		<div class="card-body">
			<div class="row">
				{#each Object.entries(bySurface) as [surface, n] (surface)}
					<ui5-tag hide-state-icon>{SURFACE_LABEL[surface as Surface]}: {n}</ui5-tag>
				{/each}
			</div>
			<div class="row">
				<StatusTag
					status={issueCount ? 'interrupted' : 'passed'}
					label={issueCount
						? `${issueCount} quality warning${issueCount === 1 ? '' : 's'}`
						: 'No quality warnings'}
				/>
			</div>
			{#if issueCount}
				<span class="muted">
					Quality warnings point at steps that are written in a fragile way. The tests still run.
				</span>
			{/if}
			<a href={testsHref()}>See all tests</a>
		</div>
	</ui5-card>

	<ui5-card>
		<ui5-card-header
			slot="header"
			title-text="Latest result"
			subtitle-text={lastRun ? when(lastRun.startedAt) : 'Nothing has run yet'}
		></ui5-card-header>
		<div class="card-body">
			{#if lastRun}
				<div class="row">
					<StatusTag status={lastRun.status} />
					<span>
						{lastRun.stats.passed} passed · {lastRun.stats.failed} failed · {lastRun.stats.skipped} skipped
					</span>
				</div>
				<span class="muted">
					{lastRun.finishedAt
						? `Took ${duration(Date.parse(lastRun.finishedAt) - Date.parse(lastRun.startedAt))}`
						: 'Still running…'}
				</span>
				{#if lastRun.stats.skipped && !sapReady}
					<span class="muted">Skipped tests need the SAP connection.</span>
				{/if}
				<a href={runHref(lastRun.id)}>Open this result</a>
			{:else}
				<span class="muted">Start with “Try the demo” to see how a test run looks.</span>
			{/if}
		</div>
	</ui5-card>
</div>

<ui5-panel
	header-text="Reliability: {stableCount} of {stab.current?.rows.length ??
		0} tests passed {target} times in a row{view.technical ? ' (guide §4.8)' : ''}"
	fixed
>
	{#if stab.current && stab.current.rows.length}
		<p class="muted explain">
			A test counts as reliable once it has passed {target} times in a row. Each dot is one run, oldest
			first: green passed, red failed. Click a dot to open that run.
		</p>
		<ui5-table>
			<ui5-table-header-row slot="headerRow">
				<ui5-table-header-cell min-width="240px">Test</ui5-table-header-cell>
				<ui5-table-header-cell>Last result</ui5-table-header-cell>
				<ui5-table-header-cell min-width="200px">Passes in a row</ui5-table-header-cell>
				<ui5-table-header-cell>History</ui5-table-header-cell>
			</ui5-table-header-row>
			{#each stab.current.rows as row (row.key)}
				<ui5-table-row>
					<ui5-table-cell>
						<div>
							<a href={flowHref(row.key)}>{row.title}</a>
							{#if view.technical}<div class="muted mono">{row.file}</div>{/if}
						</div>
					</ui5-table-cell>
					<ui5-table-cell><StatusTag status={row.lastStatus} /></ui5-table-cell>
					<ui5-table-cell>
						<ui5-progress-indicator
							value={Math.min(100, (row.streak / target) * 100)}
							display-value="{row.streak} of {target}"
							value-state={row.streak >= target
								? 'Positive'
								: row.lastStatus === 'passed'
									? 'None'
									: 'Negative'}
						></ui5-progress-indicator>
					</ui5-table-cell>
					<ui5-table-cell><HistoryDots history={row.history} /></ui5-table-cell>
				</ui5-table-row>
			{/each}
		</ui5-table>
	{:else}
		<p class="muted">
			Nothing has finished yet. Tests that were skipped because the SAP connection is missing do not
			count.
		</p>
	{/if}
</ui5-panel>

<style>
	.start {
		margin-bottom: 1rem;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0 1rem 0.5rem;
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0;
		border-top: 1px solid var(--sapList_BorderColor);
	}
	.steps li > div {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.steps ui5-icon {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--sapContent_IconColor);
	}
	.steps .done ui5-icon {
		color: var(--sapPositiveColor);
	}
	.steps ui5-button,
	.steps a {
		flex: none;
	}
	.check {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.explain {
		margin: 0 0 0.5rem;
	}
	@media (max-width: 600px) {
		.steps li {
			flex-wrap: wrap;
		}
		.steps li > div {
			flex-basis: calc(100% - 2rem);
		}
	}
</style>
