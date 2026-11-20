<script lang="ts">
	import { page } from '$app/state';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { flowHref, runFileHref, traceHref } from '#lib/client/links.js';
	import { errorMessage, runAndOpen } from '#lib/client/run-actions.js';
	import { duration, when } from '#lib/shared/format.js';
	import {
		getRun,
		getRuns,
		getStability,
		stopTestRun,
		watchRunLive
	} from '#lib/remote/runs.remote.js';
	import type { RunStep, RunTest } from '#lib/shared/types.js';

	const id = $derived(page.params.id ?? '');
	const runs = getRuns();
	const isLive = $derived(runs.current?.active === id);
	const query = $derived(isLive ? watchRunLive(id) : getRun(id));
	const run = $derived(query.current);
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

	function topSteps(t: RunTest): RunStep[] {
		return t.steps.filter((s) => !s.parentId);
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
	<ui5-illustrated-message name="NoSearchResults" title-text="Run not found"
	></ui5-illustrated-message>
{:else if run}
	<div class="page-head">
		<div>
			<ui5-title level="H3">Run {when(run.startedAt)}</ui5-title>
			<div class="muted mono">{run.files.length ? run.files.join(', ') : 'all tests'}</div>
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
				<ui5-button
					icon="document"
					onclick={() => window.open(`/runs/${id}/files/report/index.html`, '_blank')}
				>
					HTML report
				</ui5-button>
			{/if}
		{/if}
	</div>

	{#if error}
		<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
	{/if}

	<div class="grid summary">
		<ui5-card>
			<div class="card-body pad">
				<span class="muted">Progress</span>
				<ui5-progress-indicator
					value={run.stats.total ? (done / run.stats.total) * 100 : 0}
					display-value="{done} / {run.stats.total}"
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
					{duration(elapsed)}{run.exitCode !== undefined && run.exitCode !== null
						? ` · exit ${run.exitCode}`
						: ''}
				</span>
			</div>
		</ui5-card>
	</div>

	{#each run.tests as t (t.testId)}
		{@const b = bars(t)}
		{@const tr = traceUrl(t)}
		<ui5-panel
			collapsed={t.status === 'passed' || t.status === 'skipped' || undefined}
			class="test-panel"
		>
			<div slot="header" class="test-head">
				<StatusTag
					status={t.running ? 'running' : t.status}
					label={t.running ? 'running' : undefined}
				/>
				<span class="title">{t.title}</span>
				<span class="muted mono">{t.file}:{t.line}</span>
				<span class="spacer"></span>
				<span class="muted">{duration(t.duration)}</span>
			</div>
			<div class="test-body">
				<div class="row">
					<a href={flowHref(t.key, id)}>View flow</a>
					{#if tr}<a href={tr} target="_blank" rel="noreferrer">Open trace</a>{/if}
					{#if !t.running && t.status && t.status !== 'passed' && t.status !== 'skipped'}
						<ui5-button
							design="Transparent"
							icon="play"
							onclick={() => rerun([`${t.file}:${t.line}`])}
						>
							Re-run test
						</ui5-button>
					{/if}
				</div>
				{#if t.error}
					<pre class="log">{t.error.message}</pre>
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
							{:else}
								<a href={runFileHref(id, a.path)} download>{a.name}</a>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		</ui5-panel>
	{/each}

	<ui5-panel header-text="Output" collapsed={run.status !== 'running' || undefined}>
		<pre class="log" bind:this={logEl}>{run.log.join('\n')}</pre>
	</ui5-panel>
{:else}
	<ui5-busy-indicator active size="L" style="width: 100%; margin-top: 4rem"></ui5-busy-indicator>
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
	.spacer {
		flex: 1;
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
		grid-template-columns: minmax(160px, 34%) 1fr 70px;
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
		background: var(--sapList_HeaderBackground, #f5f6f7);
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
		max-width: 420px;
		max-height: 260px;
		border: 1px solid var(--sapGroup_ContentBorderColor);
		border-radius: 0.5rem;
	}
</style>
