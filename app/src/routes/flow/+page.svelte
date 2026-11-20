<script lang="ts">
	import '@xyflow/svelte/dist/style.css';
	import { Background, Controls, SvelteFlow, type Edge, type Node } from '@xyflow/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import StepNode from '#lib/components/flow/StepNode.svelte';
	import TerminalNode from '#lib/components/flow/TerminalNode.svelte';
	import { flowHref, runFileHref, runHref, testsHref, traceHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { overlaySteps } from '#lib/shared/flow-overlay.js';
	import { duration, LOCATOR_LABEL, SURFACE_LABEL, when } from '#lib/shared/format.js';
	import { getSpecSource, getSpecs } from '#lib/remote/specs.remote.js';
	import { getRun, getRuns, startTestRun, watchRunLive } from '#lib/remote/runs.remote.js';

	const nodeTypes = { step: StepNode, terminal: TerminalNode };
	const ROW = 104;

	const key = $derived(page.url.searchParams.get('key') ?? '');
	const specs = getSpecs();
	const runs = getRuns();
	const test = $derived(specs.current?.flatMap((f) => f.tests).find((t) => t.key === key));
	const source = $derived(test ? getSpecSource(test.file) : undefined);

	const active = $derived(runs.current?.active ?? null);
	const runId = $derived(
		page.url.searchParams.get('run') ?? active ?? runs.current?.runs[0]?.id ?? null
	);
	const live = $derived(runId && runId === active);
	const runQuery = $derived(runId ? (live ? watchRunLive(runId) : getRun(runId)) : undefined);
	const run = $derived(runQuery?.current ?? null);
	const runTest = $derived(run?.tests.find((t) => t.key === key));
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
					label: end ? `Test ${end}` : 'End',
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
			const { id } = await startTestRun({ files: [`${test.file}:${test.line}`] });
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

{#if specs.current && !test}
	<ui5-illustrated-message name="NoSearchResults" title-text="Test not found">
		<span slot="subtitle"><a href={testsHref()}>Back to tests</a></span>
	</ui5-illustrated-message>
{:else if test}
	<div class="page-head">
		<div>
			<ui5-title level="H3">{test.title}</ui5-title>
			<div class="muted mono">{test.file}:{test.line}</div>
		</div>
		<ui5-tag hide-state-icon>{SURFACE_LABEL[test.surface]}</ui5-tag>
		<span class="spacer"></span>
		<ui5-label show-colon>Run</ui5-label>
		<ui5-select onchange={pickRun} style="min-width: 260px">
			{#each runs.current?.runs ?? [] as r (r.id)}
				<ui5-option data-id={r.id} selected={r.id === runId || undefined}>
					{r.id === active ? '● live · ' : ''}{when(r.startedAt)} · {r.status}
				</ui5-option>
			{/each}
		</ui5-select>
		<ui5-button icon="play" design="Emphasized" onclick={runThis} disabled={!!active || undefined}>
			Run this test
		</ui5-button>
	</div>

	{#if error}
		<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
	{/if}
	{#if run && !runTest}
		<ui5-message-strip design="Information" hide-close-button>
			This test was not part of the selected run.
		</ui5-message-strip>
	{/if}

	<div class="layout">
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
						{#if run}<a href={runHref(run.id)}>Open run</a>{/if}
					</div>
					{#if runTest.error}
						<pre class="log">{runTest.error.message}</pre>
					{/if}
					{#if screenshot || trace}
						<div class="row">
							{#if trace && run?.hasReport}
								<a target="_blank" rel="noreferrer" href={traceHref(run.id, trace.path)}>
									Open trace
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
					<ui5-title level="H5">
						{selected.kind === 'group' ? selected.value : selected.action}
					</ui5-title>
					<dl>
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
							<strong>{issue.rule}</strong>: {issue.message}
						</ui5-message-strip>
					{/each}
				{:else}
					<span class="muted">
						Click a step to see its locator, rule findings and Playwright calls.
					</span>
					{#if test.issues.length}
						<ui5-message-strip design="Critical" hide-close-button>
							{test.issues.length} rule finding{test.issues.length > 1 ? 's' : ''} in this test, marked
							on the steps.
						</ui5-message-strip>
					{/if}
				{/if}
			</section>

			<section class="code" bind:this={codeEl}>
				{#each sourceLines as text, i (i)}
					{@const n = i + 1}
					<div class="line" class:hl={n >= highlight.from && n <= highlight.to} data-line={n}>
						<span class="no">{n}</span><span class="txt">{text || ' '}</span>
					</div>
				{/each}
			</section>
		</aside>
	</div>
{/if}

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 420px;
		gap: 1rem;
		height: calc(100vh - 11rem);
		min-height: 480px;
	}
	.canvas {
		border: 1px solid var(--sapGroup_ContentBorderColor, #d9d9d9);
		border-radius: 0.75rem;
		overflow: hidden;
		background: var(--sapGroup_ContentBackground, #fff);
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
		.layout {
			grid-template-columns: 1fr;
			height: auto;
		}
		.canvas {
			height: 70vh;
		}
	}
</style>
