<script lang="ts">
	import '@xyflow/svelte/dist/style.css';
	import { Background, Controls, SvelteFlow, type Edge, type Node } from '@xyflow/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import StepNode from '#lib/components/flow/StepNode.svelte';
	import TerminalNode from '#lib/components/flow/TerminalNode.svelte';
	import {
		flowHref,
		reportHref,
		runFileHref,
		runHref,
		testsHref,
		traceHref
	} from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { matchFlow } from '#lib/shared/flow-match.js';
	import { overlaySteps } from '#lib/shared/flow-overlay.js';
	import { duration, LOCATOR_LABEL, statusLabel, SURFACE_LABEL, when } from '#lib/shared/format.js';
	import { describeStep } from '#lib/shared/step-text.js';
	import { getSpecSource, getSpecs } from '#lib/remote/specs.remote.js';
	import { getRun, getRuns, startTestRun, watchRunLive } from '#lib/remote/runs.remote.js';

	const nodeTypes = { step: StepNode, terminal: TerminalNode };
	const ROW = 104;

	const key = $derived(page.url.searchParams.get('key') ?? '');
	const specs = getSpecs();
	const runs = getRuns();

	const active = $derived(runs.current?.active ?? null);
	const runId = $derived(
		page.url.searchParams.get('run') ?? active ?? runs.current?.runs[0]?.id ?? null
	);
	const live = $derived(runId && runId === active);
	// A key is `<spec file>::<title>`. The live view carries the steps of that file's tests only.
	const file = $derived(key.split('::')[0] ?? '');
	const runQuery = $derived(
		runId ? (live ? watchRunLive({ id: runId, file }) : getRun(runId)) : undefined
	);
	const run = $derived(runQuery?.current ?? null);
	// Also resolves a test with a generated title, whose key differs between spec and run.
	const flow = $derived(
		matchFlow(specs.current?.flatMap((f) => f.tests) ?? [], run?.tests ?? [], key)
	);
	const test = $derived(flow.test);
	/** Findings on the whole spec file, such as a missing reviewer; not tied to a step. */
	const fileIssues = $derived(specs.current?.find((f) => f.file === test?.file)?.issues ?? []);
	const runTest = $derived(flow.runTest);
	const source = $derived(test ? getSpecSource(test.file) : undefined);
	const overlay = $derived(test ? overlaySteps(test.steps, runTest) : {});

	// The live stream ends with the run; refresh the run list so `active` clears and the picker updates.
	$effect(() => {
		if (live && run && run.status !== 'running') void runs.refresh();
	});

	let selectedId = $state<string | null>(null);
	const selected = $derived(test?.steps.find((s) => s.id === selectedId));
	const selectedOverlay = $derived(selected ? overlay[selected.id] : undefined);
	let error = $state<string | null>(null);

	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);

	$effect(() => {
		if (!test) return;
		const steps = test.steps;
		const end = runTest?.status ?? (runTest?.running ? 'running' : undefined);
		nodes = [
			{
				id: 'start',
				type: 'terminal',
				position: { x: 0, y: 0 },
				data: { label: test.title, sub: SURFACE_LABEL[test.surface] },
				draggable: false
			},
			...steps.map((step, i) => ({
				id: step.id,
				type: 'step',
				position: { x: 0, y: (i + 1) * ROW },
				data: { step, overlay: overlay[step.id] },
				selected: step.id === selectedId,
				draggable: false
			})),
			{
				id: 'end',
				type: 'terminal',
				position: { x: 0, y: (steps.length + 1) * ROW },
				data: {
					label: end ? `Test ${statusLabel(end).toLowerCase()}` : 'End',
					sub: runTest?.duration === undefined ? undefined : duration(runTest.duration),
					status: end
				},
				draggable: false
			}
		];
		const ids = ['start', ...steps.map((s) => s.id), 'end'];
		edges = ids.flatMap((src, i) => {
			const target = ids[i + 1];
			if (!target) return [];
			const status = src === 'start' ? (runTest ? 'passed' : undefined) : overlay[src]?.status;
			const next = target === 'end' ? undefined : overlay[target]?.status;
			const edge: Edge = {
				id: `${src}-${target}`,
				source: src,
				target,
				animated: next === 'running',
				style:
					status === 'passed'
						? 'stroke: var(--sapPositiveColor); stroke-width: 2px'
						: status === 'failed'
							? 'stroke: var(--sapNegativeColor); stroke-width: 2px'
							: 'stroke-dasharray: 4 4'
			};
			return [edge];
		});
	});

	const sourceLines = $derived(source?.current?.split('\n') ?? []);
	const highlight = $derived(
		selected
			? { from: selected.line, to: selected.endLine }
			: { from: test?.line ?? 0, to: test?.line ?? 0 }
	);
	let codeEl = $state<HTMLElement | null>(null);
	$effect(() => {
		const line = highlight.from;
		codeEl
			?.querySelector(`[data-line="${line}"]`)
			?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	});

	async function runThis() {
		if (!test) return;
		try {
			const { id } = await startTestRun({
				files: [`${test.file}:${test.line}`],
				headed: view.showBrowser
			});
			await goto(flowHref(key, id), { replace: true });
		} catch (e) {
			error = errorMessage(e);
		}
	}

	function pickRun(e: CustomEvent<{ selectedOption: HTMLElement }>) {
		void goto(flowHref(key, e.detail.selectedOption.dataset.id), { replace: true });
	}

	const screenshot = $derived(runTest?.attachments.find((a) => a.contentType.startsWith('image/')));
	const trace = $derived(runTest?.attachments.find((a) => a.name === 'trace'));
</script>

{#if specs.current && !test && (!runId || run || runQuery?.error)}
	<ui5-illustrated-message name="NoSearchResults" title-text="This test no longer exists">
		<span slot="subtitle"><a href={testsHref()}>Back to all tests</a></span>
	</ui5-illustrated-message>
{:else if test}
	<div class="page-head">
		<div>
			<ui5-title level="H3">{test.dynamic && runTest ? runTest.title : test.title}</ui5-title>
			{#if view.technical}
				<div class="muted mono">{test.file}:{test.line}</div>
			{:else}
				<div class="muted">
					What this test does, step by step, from top to bottom{runTest
						? ', and how each step went'
						: ''}
				</div>
			{/if}
		</div>
		<ui5-tag hide-state-icon>{SURFACE_LABEL[test.surface]}</ui5-tag>
		{#if test.dynamic && view.technical}
			<ui5-tag hide-state-icon design="Information">generated title</ui5-tag>
		{/if}
		<span class="spacer"></span>
		<ui5-label for="run-picker" show-colon>Show the run from</ui5-label>
		<ui5-select id="run-picker" onchange={pickRun} style="min-width: 260px">
			{#each runs.current?.runs ?? [] as r (r.id)}
				<ui5-option data-id={r.id} selected={r.id === runId || undefined}>
					{r.id === active ? '● live · ' : ''}{when(r.startedAt)} · {statusLabel(r.status)}
				</ui5-option>
			{/each}
			<!-- The list holds the newest runs only; a run opened from further back still shows. -->
			{#if run && !runs.current?.runs.some((r) => r.id === run.id)}
				<ui5-option data-id={run.id} selected>
					{when(run.startedAt)} · {statusLabel(run.status)}
				</ui5-option>
			{/if}
		</ui5-select>
		<ui5-button icon="play" design="Emphasized" onclick={runThis} disabled={!!active || undefined}>
			Run this test
		</ui5-button>
	</div>

	{#if error}
		<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
	{/if}
	{#if runTest?.detailsRemoved}
		<ui5-message-strip design="Information" hide-close-button>
			The selected run is older, so how each step went was removed to save space. The result of the
			test is kept. Pick a newer run or press “Run this test”.
		</ui5-message-strip>
	{/if}
	{#if run && !runTest}
		<ui5-message-strip design="Information" hide-close-button>
			This test was not part of the selected run, so the steps show no results. Pick another run or
			press “Run this test”.
		</ui5-message-strip>
	{/if}

	<div class="layout" class:plain={!view.technical}>
		<div class="canvas">
			<SvelteFlow
				bind:nodes
				bind:edges
				{nodeTypes}
				fitView
				fitViewOptions={{ maxZoom: 1, padding: 0.15 }}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable
				minZoom={0.2}
				onnodeclick={({ node }) => (selectedId = node.type === 'step' ? node.id : null)}
				onpaneclick={() => (selectedId = null)}
			>
				<Background gap={20} />
				<Controls showLock={false} />
			</SvelteFlow>
		</div>

		<aside class="side">
			{#if runTest}
				<section>
					<div class="row">
						<StatusTag status={runTest.running ? 'running' : runTest.status} />
						<span class="muted">
							{duration(runTest.duration)}{runTest.retry ? ` · retry ${runTest.retry}` : ''}
						</span>
						{#if run}<a href={runHref(run.id)}>Open the whole run</a>{/if}
					</div>
					{#if runTest.error && view.technical}
						<pre class="log">{runTest.error.message}</pre>
					{:else if runTest.error}
						<span>
							The test stopped at the step marked in red. The steps after it were not reached.
						</span>
						{#if screenshot && run}
							<a target="_blank" rel="noreferrer" href={runFileHref(run.id, screenshot.path)}>
								<img
									class="shot"
									src={runFileHref(run.id, screenshot.path)}
									alt="The screen when the test stopped"
								/>
							</a>
						{/if}
						<details>
							<summary>Show the error message</summary>
							<pre class="log">{runTest.error.message}</pre>
						</details>
					{/if}
					{#if screenshot || trace || run?.hasReport}
						<div class="row">
							{#if run?.hasReport && runTest.status}
								<a
									target="_blank"
									rel="noreferrer"
									href={reportHref(run.id, runTest.testId)}
									title="This test case in Playwright's HTML report"
								>
									Playwright result
								</a>
							{/if}
							{#if trace && run?.hasReport}
								<a target="_blank" rel="noreferrer" href={traceHref(run.id, trace.path)}>
									Replay step by step
								</a>
							{/if}
							{#if screenshot && run}
								<a target="_blank" rel="noreferrer" href={runFileHref(run.id, screenshot.path)}>
									Screenshot
								</a>
							{/if}
						</div>
					{/if}
				</section>
			{/if}

			<section>
				{#if selected}
					<ui5-title level="H5" wrapping-type="Normal">
						{view.technical
							? selected.kind === 'group'
								? selected.value
								: selected.action
							: describeStep(selected)}
					</ui5-title>
					{#if !view.technical}
						{#if selected.hook}
							<span class="muted">This step runs before every test in this group.</span>
						{/if}
						{#if selectedOverlay}
							<div class="row">
								<StatusTag
									status={selectedOverlay.status}
									label={selectedOverlay.status === 'skipped' ? 'Not reached' : undefined}
								/>
								{#if selectedOverlay.duration !== undefined}
									<span class="muted">took {duration(selectedOverlay.duration)}</span>
								{/if}
							</div>
						{:else}
							<span class="muted">Run the test to see how this step goes.</span>
						{/if}
					{/if}
					<dl class:hidden={!view.technical}>
						<dt>Kind</dt>
						<dd>{selected.kind}{selected.hook ? ' (beforeEach)' : ''}</dd>
						{#if selected.locator}
							<dt>Locator</dt>
							<dd>
								<span class="mono">{selected.locator.display}</span><br />
								<span class="muted">
									{LOCATOR_LABEL[selected.locator.kind]}{selected.locator.helper
										? ` via helpers/${selected.locator.helper}`
										: ''}
								</span>
							</dd>
						{/if}
						{#if selected.value !== undefined}
							<dt>Value</dt>
							<dd class="mono">{selected.value}</dd>
						{/if}
						<dt>Lines</dt>
						<dd>
							{selected.line}{selected.endLine !== selected.line ? `–${selected.endLine}` : ''}
						</dd>
						{#if selectedOverlay}
							<dt>Result</dt>
							<dd>
								<StatusTag status={selectedOverlay.status} />
								{duration(selectedOverlay.duration)}
							</dd>
							{#if selectedOverlay.calls.length}
								<dt>Playwright calls</dt>
								<dd>
									<ul class="calls">
										{#each selectedOverlay.calls as c, i (i)}<li class="mono">{c}</li>{/each}
									</ul>
								</dd>
							{/if}
						{/if}
					</dl>
					{#each selected.issues as issue, i (i)}
						<ui5-message-strip
							design={issue.severity === 'error'
								? 'Negative'
								: issue.severity === 'warning'
									? 'Critical'
									: 'Information'}
							hide-close-button
						>
							{#if view.technical}
								<strong>{issue.rule}</strong>: {issue.message}
							{:else}
								Note for whoever maintains this test: {issue.message}
							{/if}
						</ui5-message-strip>
					{/each}
				{:else}
					<span class="muted">
						{view.technical
							? 'Click a step to see its locator, rule findings and Playwright calls.'
							: 'Click a step to see what it does and how it went.'}
					</span>
					{#each fileIssues as issue (issue.rule + issue.line)}
						<ui5-message-strip design="Critical" hide-close-button>
							{view.technical ? `Line ${issue.line}: ` : ''}{issue.message}
						</ui5-message-strip>
					{/each}
					{#if test.issues.length}
						<ui5-message-strip design="Critical" hide-close-button>
							{test.issues.length} quality warning{test.issues.length > 1 ? 's' : ''} in this test, marked
							on the steps.
						</ui5-message-strip>
					{/if}
				{/if}
			</section>

			{#if view.technical}
				<section class="code" bind:this={codeEl}>
					{#each sourceLines as text, i (i)}
						{@const n = i + 1}
						<div class="line" class:hl={n >= highlight.from && n <= highlight.to} data-line={n}>
							<span class="no">{n}</span><span class="txt">{text || ' '}</span>
						</div>
					{/each}
				</section>
			{/if}
		</aside>
	</div>
{/if}

<style>
	.layout {
		display: grid;
		/* The flow is one 300px column; the source next to it is what needs the width. */
		grid-template-columns: minmax(360px, 1fr) minmax(420px, 1fr);
		gap: 1rem;
		height: calc(100vh - 11rem);
		min-height: 480px;
	}
	/* Without the source there is little next to the steps, so they get the room. */
	.layout.plain {
		grid-template-columns: minmax(360px, 1fr) minmax(280px, 26rem);
	}
	.hidden {
		display: none;
	}
	.shot {
		display: block;
		max-width: 100%;
		max-height: 14rem;
		border: 1px solid var(--sapGroup_ContentBorderColor);
		border-radius: 0.5rem;
	}
	summary {
		cursor: pointer;
		color: var(--sapLinkColor);
		margin-bottom: 0.5rem;
	}
	.canvas {
		border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
		border-radius: 0.75rem;
		overflow: hidden;
		background: var(--sapGroup_ContentBackground, #fff);
		/* Svelte Flow brings its own light and dark colours; keep its canvas on the theme's surface. */
		--xy-background-color: var(--sapGroup_ContentBackground);
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0;
	}
	.side section {
		background: var(--sapGroup_ContentBackground, #fff);
		border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
		border-radius: 0.75rem;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	/* The error must not push the step details and the source out of the panel. */
	.side pre.log {
		max-height: 11rem;
	}
	.side ui5-message-strip {
		margin-bottom: 0;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.75rem;
		margin: 0;
		font-size: 0.8125rem;
	}
	dt {
		color: var(--sapContent_LabelColor);
	}
	dd {
		margin: 0;
		word-break: break-word;
	}
	.calls {
		margin: 0;
		padding-left: 1rem;
	}
	.code {
		flex: 1;
		min-height: 160px;
		overflow: auto;
		font-family: var(--sapFontFamilyMono, ui-monospace, monospace);
		font-size: 0.75rem;
		tab-size: 2;
		gap: 0 !important;
		padding: 0.5rem 0 !important;
	}
	.line {
		display: flex;
		white-space: pre;
	}
	.line.hl {
		background: color-mix(in srgb, var(--sapSelectedColor, #0064d9) 14%, transparent);
	}
	.no {
		width: 2.5rem;
		flex: none;
		text-align: right;
		padding-right: 0.75rem;
		color: var(--sapContent_LabelColor);
		user-select: none;
	}
	@media (max-width: 1000px) {
		.layout,
		.layout.plain {
			grid-template-columns: minmax(0, 1fr);
			height: auto;
		}
		.canvas {
			height: 70vh;
		}
		.code {
			max-height: 60vh;
		}
	}
</style>
