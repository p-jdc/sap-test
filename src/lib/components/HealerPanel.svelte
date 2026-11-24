<script lang="ts">
	import { goto } from '$app/navigation';
	import { runHref } from '#lib/client/links.js';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { duration } from '#lib/shared/format.js';
	import {
		discardHealerRepair,
		getHealer,
		getHealing,
		runRepairedTest,
		startHealer,
		stopHealer
	} from '#lib/remote/healer.remote.js';

	/**
	 * The healer for one failed test of a finished run: a button that starts it, what it is doing,
	 * and its report with the changes it made, which stay in the working tree for review.
	 */
	let { runId, testId, runActive }: { runId: string; testId: string; runActive: boolean } =
		$props();

	const healer = getHealer();
	const healing = $derived(getHealing({ id: runId, testId }));
	const heal = $derived(healing.current);
	const working = $derived(heal?.status === 'running');
	/** Busy elsewhere: on another test, or a run is going. */
	const busy = $derived(
		runActive ||
			(!!healer.current?.active &&
				(healer.current.active.runId !== runId || healer.current.active.testId !== testId))
	);
	/** Files of this repair that nobody has read: nothing runs until it is run or discarded. */
	const unread = $derived(heal?.unreviewed ?? []);
	/** Why the healer cannot start: off or not set up, or a repair elsewhere is not read yet. */
	const startProblem = $derived(healer.current?.problem ?? healer.current?.unread ?? null);
	let error = $state<string | null>(null);
	/** The healer works on another test: asked again until it is done, so the button frees up. */
	const elsewhere = $derived(!!healer.current?.active && !working && busy && !runActive);
	$effect(() => {
		if (!elsewhere) return;
		const t = setInterval(() => {
			void healer.refresh();
		}, 5000);
		return () => {
			clearInterval(t);
		};
	});

	$effect(() => {
		if (!working) return;
		const t = setInterval(() => {
			void healing.refresh();
		}, 2000);
		return () => {
			clearInterval(t);
			// It has just finished: the button elsewhere may start again.
			void healer.refresh();
		};
	});

	async function start() {
		error = null;
		try {
			await startHealer({ id: runId, testId });
		} catch (e) {
			error = errorMessage(e);
		}
	}
	async function stop() {
		try {
			await stopHealer({ id: runId, testId });
		} catch (e) {
			error = errorMessage(e);
		}
	}
	async function discard() {
		try {
			await discardHealerRepair({ id: runId, testId });
			void healer.refresh();
		} catch (e) {
			error = errorMessage(e);
		}
	}
	async function runRepaired() {
		error = null;
		try {
			const { id } = await runRepairedTest({ id: runId, testId });
			await goto(runHref(id));
		} catch (e) {
			error = errorMessage(e);
			void healer.refresh();
		}
	}

	const elapsed = $derived(
		heal ? Date.parse(heal.finishedAt ?? new Date().toISOString()) - Date.parse(heal.startedAt) : 0
	);
</script>

<!-- Off, the healer shows only what it did before it was turned off. -->
{#if healer.current?.on || heal}
	<div class="healer">
		{#if !heal}
			<div class="row">
				<ui5-button
					design="Transparent"
					icon="stethoscope"
					onclick={start}
					disabled={!!startProblem || busy || undefined}
					title={startProblem ??
						(busy
							? 'Another test or a run is using the browser; wait until it has finished.'
							: 'The AI healer runs this test, names the cause and repairs the test if the cause lies in it')}
				>
					Diagnose with healer
				</ui5-button>
				{#if startProblem}
					<span class="muted">{startProblem}</span>
				{/if}
			</div>
		{/if}

		{#if error}
			<ui5-message-strip design="Negative" onclose={() => (error = null)}>
				{error}
			</ui5-message-strip>
		{/if}

		{#if heal}
			<div class="head">
				<ui5-title level="H6">Healer</ui5-title>
				{#if working}
					<ui5-busy-indicator active size="S"></ui5-busy-indicator>
					<span class="muted">working · {duration(elapsed)}</span>
					<span class="spacer"></span>
					<ui5-button design="Transparent" icon="stop" onclick={stop}>Stop the healer</ui5-button>
				{:else}
					<span class="muted">
						{heal.status === 'finished'
							? 'finished'
							: heal.status === 'stopped'
								? 'stopped'
								: 'did not finish'} after {duration(elapsed)}{heal.costUsd !== undefined
							? ` · about $${heal.costUsd.toFixed(2)}`
							: ''}
					</span>
				{/if}
			</div>

			{#if heal.error}
				<ui5-message-strip design="Negative" hide-close-button>{heal.error}</ui5-message-strip>
			{/if}

			{#if heal.report}
				<pre class="report">{heal.report}</pre>
			{/if}

			{#if heal.changes.length}
				{#if heal.discarded}
					<ui5-message-strip design="Information" hide-close-button>
						{#if heal.discardKept?.length}
							These changes were discarded, except in the files someone changed since, which are
							left as they are: {heal.discardKept.join(', ')}.
						{:else}
							These changes were discarded: the files are as they were before the healer.
						{/if}
					</ui5-message-strip>
				{:else if !working && unread.length}
					<ui5-message-strip design="Critical" hide-close-button>
						Not run yet. Code the healer writes runs only after a person has read it, because it
						would run with the test users' passwords: until this repair is run or discarded, no test
						runs in this app. Read the whole diff: no assertion removed or loosened, and nothing
						that reaches beyond the test (other hosts, files, the environment). “Run the repaired
						test” counts as your review.
					</ui5-message-strip>
				{:else if !working}
					<ui5-message-strip design="Critical" hide-close-button>
						The healer changed {heal.changes.length === 1 ? 'this file' : 'these files'} in the working
						tree. Nothing is committed: check that no assertion was removed or loosened, put your name
						in the line “KI-generiert, geprüft von:”, and commit it, or discard the repair.
					</ui5-message-strip>
				{/if}
				{#each heal.changes as change (change.file)}
					<details open={!heal.discarded || undefined}>
						<summary class="mono">{change.file}</summary>
						<pre class="diff">{#each change.diff.split('\n') as line, n (n)}<span
									class={[line.startsWith('+') && 'add', line.startsWith('-') && 'del']}
									>{line}</span
								>{/each}</pre>
					</details>
				{/each}
				{#if !working && !heal.discarded}
					<div class="row">
						{#if unread.length}
							<ui5-button design="Emphasized" icon="media-play" onclick={runRepaired}>
								Run the repaired test
							</ui5-button>
						{/if}
						<ui5-button design="Transparent" icon="undo" onclick={discard}>
							Discard the repair
						</ui5-button>
					</div>
				{/if}
			{/if}

			{#if heal.activity.length}
				<details open={working || undefined}>
					<summary>What the healer did ({heal.activity.length} steps)</summary>
					<ol class="activity">
						{#each heal.activity as line, n (n)}<li>{line}</li>{/each}
					</ol>
				</details>
			{/if}

			{#if !working}
				<div class="row">
					<ui5-button
						design="Transparent"
						icon="stethoscope"
						onclick={start}
						disabled={!!startProblem || busy || undefined}
						title={unread.length
							? 'Run or discard this repair first: nothing runs before it has been read.'
							: undefined}
					>
						Diagnose again
					</ui5-button>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.healer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.row,
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.report {
		white-space: pre-wrap;
		margin: 0;
		padding: 0.75rem;
		border: 1px solid var(--sapGroup_ContentBorderColor);
		border-radius: 0.5rem;
		font-family: var(--sapFontFamily);
		font-size: var(--sapFontSize);
	}
	.diff {
		margin: 0;
		padding: 0.5rem;
		overflow-x: auto;
		font-size: 0.75rem;
		background: var(--sapList_HeaderBackground);
		border-radius: 0.5rem;
	}
	/* One line each; an empty line keeps its height. */
	.diff span {
		display: block;
		min-height: 1lh;
	}
	.diff .add {
		color: var(--sapPositiveTextColor, var(--sapPositiveColor));
	}
	.diff .del {
		color: var(--sapNegativeTextColor, var(--sapNegativeColor));
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
</style>
