<script lang="ts">
	import { page } from '$app/state';
	import HealerPanel from '#lib/components/HealerPanel.svelte';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import {
		flowHref,
		reportHref,
		runFileHref,
		runsHref,
		settingsHref,
		traceHref
	} from '#lib/client/links.js';
	import { errorMessage, runAndOpen } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { duration, scopeLabel, when } from '#lib/shared/format.js';
	import {
		getRun,
		getRuns,
		getRunTestSteps,
		getStability,
		stopTestRun,
		watchRunLive
	} from '#lib/remote/runs.remote.js';
	import type { RunStep, RunTest } from '#lib/shared/types.js';

	const id = $derived(page.params.id ?? '');
	const runs = getRuns();
	const isLive = $derived(runs.current?.active === id);
	const query = $derived(isLive ? watchRunLive({ id, log: true }) : getRun(id));
	const run = $derived(query.current);
	/** The tests of a sign-in that failed did not run (Playwright skips them). */
	const signInFailed = $derived(run?.tests.some((t) => t.setup && t.status === 'failed') ?? false);
	let error = $state<string | null>(null);

	// When a live run ends, refresh the lists that depend on it.
	let wasRunning = false;
	$effect(() => {
		const running = run?.status === 'running';
		if (wasRunning && !running) {
			void runs.refresh();
			void getStability().refresh();
		}
		wasRunning = running;
	});

	let logEl = $state<HTMLElement | null>(null);
	$effect(() => {
		void run?.log.length;
		if (logEl && run?.status === 'running') logEl.scrollTop = logEl.scrollHeight;
	});

	const elapsed = $derived(
		run ? (run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt) : 0
	);
	const done = $derived(run ? run.tests.filter((t) => t.status).length : 0);

	// A live snapshot leaves out the steps of finished tests; they are fetched once per test (and
	// again after a retry). Until they arrive, the steps last seen while the test ran are shown, so
	// the timeline does not blink.
	const seen: Record<string, RunStep[] | undefined> = {};
	const fetched: Record<string, ReturnType<typeof getRunTestSteps> | undefined> = {};
	function stepsOf(t: RunTest): RunStep[] {
		if (!t.stepsOmitted) {
			seen[t.testId] = t.steps;
			return t.steps;
		}
		const retry = t.retry ?? 0;
		const steps = (fetched[`${t.testId}:${retry}`] ??= getRunTestSteps({
			id,
			testId: t.testId,
			retry
		}));
		return steps.current ?? seen[t.testId] ?? [];
	}
	function topSteps(t: RunTest): RunStep[] {
		return stepsOf(t).filter((s) => !s.parentId);
	}
	function bars(t: RunTest) {
		const steps = topSteps(t);
		const first = steps[0];
		if (!first) return [];
		const t0 = Date.parse(first.startTime);
		const end = Math.max(...steps.map((s) => Date.parse(s.startTime) + (s.duration ?? 0)), t0 + 1);
		const total = end - t0;
		return steps.map((s) => {
			const left = Math.min(99.4, ((Date.parse(s.startTime) - t0) / total) * 100);
			const raw = ((s.duration ?? Date.now() - Date.parse(s.startTime)) / total) * 100;
			return { s, left, width: Math.min(100 - left, Math.max(0.6, raw)) };
		});
	}
	function traceUrl(t: RunTest) {
		const trace = t.attachments.find((a) => a.name === 'trace');
		if (!trace || !run?.hasReport) return null;
		return traceHref(id, trace.path);
	}

	async function stop() {
		try {
			await stopTestRun(id);
		} catch (e) {
			error = errorMessage(e);
		}
	}
	async function rerun(files: string[]) {
		error = await runAndOpen({ files });
	}
</script>

{#if query.error}
	<ui5-illustrated-message name="NoSearchResults" title-text="This result no longer exists">
		<span slot="subtitle"><a href={runsHref()}>See all results</a></span>
	</ui5-illustrated-message>
{:else if run}
	<div class="page-head">
		<div>
			<ui5-title level="H3">Run from {when(run.startedAt)}</ui5-title>
			{#if view.technical}
				<div class="muted mono">{run.files.length ? run.files.join(', ') : 'all tests'}</div>
			{:else}
				<div class="muted">{scopeLabel(run.files)}</div>
			{/if}
		</div>
		<StatusTag status={run.status} />
		<span class="spacer"></span>
		{#if run.status === 'running'}
			<ui5-button icon="stop" design="Negative" onclick={stop}>Stop</ui5-button>
		{:else}
			<ui5-button
				icon="refresh"
				onclick={() => rerun(run.files)}
				disabled={!!runs.current?.active || undefined}
			>
				Run again
			</ui5-button>
			{#if run.hasReport}
				<ui5-button icon="document" onclick={() => window.open(reportHref(id), '_blank')}>
					Playwright report
				</ui5-button>
			{/if}
		{/if}
	</div>

	{#if error}
		<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
	{/if}
	{#if run.tests.some((t) => t.detailsRemoved)}
		<ui5-message-strip design="Information" hide-close-button>
			This run is older, so the steps and error messages of its tests were removed to save space.
			Which tests passed and failed is kept.
		</ui5-message-strip>
	{:else if run.artifactsRemoved}
		<ui5-message-strip design="Information" hide-close-button>
			The report, screenshots, videos and traces of this run were removed to save space. Its results
			are kept.
		</ui5-message-strip>
	{/if}

	<div class="grid summary">
		<ui5-card>
			<div class="card-body pad">
				<span class="muted">Progress</span>
				<ui5-progress-indicator
					value={run.stats.total ? (done / run.stats.total) * 100 : 0}
					display-value="{done} of {run.stats.total} tests"
					value-state={run.stats.failed
						? 'Negative'
						: run.status === 'passed'
							? 'Positive'
							: 'Information'}
				></ui5-progress-indicator>
			</div>
		</ui5-card>
		<ui5-card>
			<div class="card-body pad">
				<span class="muted">Result</span>
				<span>
					<b>{run.stats.passed}</b> passed · <b>{run.stats.failed}</b> failed ·
					<b>{run.stats.skipped}</b> skipped
				</span>
			</div>
		</ui5-card>
		<ui5-card>
			<div class="card-body pad">
				<span class="muted">Duration</span>
				<span>
					{duration(elapsed)}{view.technical && run.exitCode !== undefined && run.exitCode !== null
						? ` · exit ${run.exitCode}`
						: ''}
				</span>
			</div>
		</ui5-card>
	</div>

	{#each run.tests as t (t.testId)}
		{@const b = view.technical ? bars(t) : []}
		{@const tr = traceUrl(t)}
		<ui5-panel
			collapsed={t.status === 'passed' || t.status === 'skipped' || undefined}
			class="test-panel"
		>
			<div slot="header" class="test-head">
				<StatusTag status={t.running ? 'running' : t.status} />
				<span class="title">{t.title}</span>
				{#if t.expectedFailure}
					<span class="muted">
						failed as expected{view.technical ? ' (test.fail)' : ''}
					</span>
				{/if}
				{#if view.technical}<span class="muted mono where">{t.file}:{t.line}</span>{/if}
				<span class="spacer"></span>
				<span class="muted dur">{duration(t.duration)}</span>
			</div>
			<div class="test-body">
				{#if t.setup}
					<span class="muted">
						Signs in once for the tests of this run, which start signed in. It runs without a trace
						or video, so the password stays out of the run's records.
					</span>
				{/if}
				<div class="row">
					{#if !t.setup}<a href={flowHref(t.key, id)}>View the steps</a>{/if}
					{#if run.hasReport && t.status}
						<a
							href={reportHref(id, t.testId)}
							target="_blank"
							rel="noreferrer"
							title="This test case in Playwright's HTML report"
						>
							Playwright result
						</a>
					{/if}
					{#if tr}
						<a href={tr} target="_blank" rel="noreferrer" title="Opens the Playwright trace viewer">
							Replay step by step
						</a>
					{/if}
					{#if !t.setup && !t.running && t.status && t.status !== 'passed' && t.status !== 'skipped'}
						<ui5-button
							design="Transparent"
							icon="play"
							onclick={() => rerun([`${t.file}:${t.line}`])}
						>
							Run this test again
						</ui5-button>
					{/if}
				</div>
				{#if t.status === 'skipped' && signInFailed && !t.setup}
					<span class="muted">This test did not run because signing in failed.</span>
				{:else if t.status === 'skipped' && !view.technical}
					<span class="muted">
						This test was skipped. Most often the SAP connection is not set up yet; check
						<a href={settingsHref()}>Settings</a>.
					</span>
				{/if}
				{#if t.error && view.technical}
					<pre class="log">{t.error.message}</pre>
				{:else if t.error && t.setup}
					<ui5-message-strip design="Negative" hide-close-button>
						Signing in failed, so the tests that need it did not run. Check the user and password in
						<a href={settingsHref()}>Settings</a>{t.attachments.length
							? '; the picture below shows the screen at that moment'
							: ''}.
					</ui5-message-strip>
				{:else if t.error}
					<ui5-message-strip design="Negative" hide-close-button>
						This test did not finish successfully. “View the steps” shows where it stopped{t
							.attachments.length
							? ', and the picture below shows the screen at that moment'
							: ''}.
					</ui5-message-strip>
					<details>
						<summary>Show the error message</summary>
						<pre class="log">{t.error.message}</pre>
					</details>
				{/if}
				{#if !t.setup && (t.status === 'failed' || t.status === 'timedOut') && run.status !== 'running'}
					<HealerPanel runId={id} testId={t.testId} runActive={!!runs.current?.active} />
				{/if}
				{#if b.length}
					<div class="timeline" aria-label="Step timeline">
						{#each b as bar (bar.s.stepId)}
							<div class="tl-row">
								<span class="tl-label mono" title={bar.s.title}>{bar.s.title}</span>
								<span class="tl-track">
									<span
										class="tl-bar"
										class:err={!!bar.s.error}
										class:open={bar.s.duration === undefined}
										style="left: {bar.left}%; width: {bar.width}%"
									></span>
								</span>
								<span class="tl-dur muted">
									{bar.s.duration === undefined ? '…' : duration(bar.s.duration)}
								</span>
							</div>
						{/each}
					</div>
				{/if}
				{#if t.attachments.length}
					<div class="attachments">
						{#each t.attachments as a (a.path)}
							{#if a.contentType.startsWith('image/')}
								<a href={runFileHref(id, a.path)} target="_blank" rel="noreferrer">
									<img src={runFileHref(id, a.path)} alt="{a.name} of {t.title}" />
								</a>
							{:else if a.contentType.startsWith('video/')}
								<!-- svelte-ignore a11y_media_has_caption -->
								<video src={runFileHref(id, a.path)} controls preload="metadata"></video>
							{:else if view.technical}
								<a href={runFileHref(id, a.path)} download>Download {a.name}</a>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		</ui5-panel>
	{/each}

	<ui5-panel
		header-text="Technical log"
		collapsed={!(view.technical && run.status === 'running') || undefined}
	>
		<pre class="log" bind:this={logEl}>{run.log.join('\n')}</pre>
	</ui5-panel>
{:else}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{/if}

<style>
	.summary {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}
	.pad {
		padding: 0.75rem 1rem;
	}
	.test-panel {
		margin-bottom: 0.5rem;
	}
	.test-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-width: 0;
	}
	.test-head .title {
		font-weight: 600;
	}
	/* The file path is the first thing to give way when the header runs out of room. */
	.test-head .where {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.test-head .dur {
		flex: none;
	}
	.spacer {
		flex: 1;
	}
	.test-body ui5-message-strip {
		margin-bottom: 0;
	}
	summary {
		cursor: pointer;
		color: var(--sapLinkColor);
		margin-bottom: 0.5rem;
	}
	.test-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.timeline {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tl-row {
		display: grid;
		grid-template-columns: minmax(100px, 34%) 1fr 70px;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.75rem;
	}
	.tl-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tl-track {
		position: relative;
		overflow: hidden;
		height: 12px;
		background: var(--sapNeutralBackground, var(--sapList_HeaderBackground));
		border-radius: 3px;
	}
	.tl-bar {
		position: absolute;
		top: 0;
		bottom: 0;
		background: var(--sapPositiveColor);
		border-radius: 3px;
	}
	.tl-bar.err {
		background: var(--sapNegativeColor);
	}
	.tl-bar.open {
		background: var(--sapInformativeColor);
	}
	.tl-dur {
		text-align: right;
	}
	.attachments {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
		align-items: flex-start;
	}
	.attachments img,
	.attachments video {
		max-width: min(420px, 100%);
		max-height: 260px;
		border: 1px solid var(--sapGroup_ContentBorderColor);
		border-radius: 0.5rem;
	}
</style>
