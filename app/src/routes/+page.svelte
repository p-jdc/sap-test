<script lang="ts">
	import HistoryDots from '#lib/components/HistoryDots.svelte';
	import StatusTag from '#lib/components/StatusTag.svelte';
	import { runAndOpen } from '#lib/client/run-actions.js';
	import { duration, SURFACE_LABEL, when } from '#lib/shared/format.js';
	import { getEnvStatus, getSpecs } from '#lib/remote/specs.remote.js';
	import { getRuns, getStability } from '#lib/remote/runs.remote.js';
	import type { Surface } from '#lib/shared/types.js';

	const env = getEnvStatus();
	const specs = getSpecs();
	const runs = getRuns();
	const stab = getStability();

	let error = $state<string | null>(null);

	const lastRun = $derived(runs.current?.runs[0]);
	const tests = $derived(specs.current?.flatMap((f) => f.tests) ?? []);
	const bySurface = $derived(
		tests.reduce<Record<string, number>>(
			(acc, t) => ((acc[t.surface] = (acc[t.surface] ?? 0) + 1), acc),
			{}
		)
	);
	const issueCount = $derived(
		tests.reduce((n, t) => n + t.issues.filter((i) => i.severity !== 'info').length, 0)
	);
	const target = $derived(stab.current?.target ?? 10);
	const stableCount = $derived(stab.current?.rows.filter((r) => r.streak >= target).length ?? 0);

	async function run(files?: string[]) {
		error = await runAndOpen({ files });
	}
</script>

<div class="page-head">
	<ui5-title level="H2">Dashboard</ui5-title>
	<span class="spacer"></span>
	<ui5-button
		icon="play"
		design="Emphasized"
		onclick={() => run()}
		disabled={!!runs.current?.active || undefined}
	>
		Run all tests
	</ui5-button>
	<ui5-button
		icon="lab"
		onclick={() => run(['_demo'])}
		disabled={!!runs.current?.active || undefined}
	>
		Run demo
	</ui5-button>
</div>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}
{#if runs.current?.active}
	<ui5-message-strip design="Information" hide-close-button>
		A run is in progress. <a href="/runs/{runs.current.active}">Watch it live</a>
	</ui5-message-strip>
{/if}

<div class="grid">
	<ui5-card>
		<ui5-card-header
			slot="header"
			title-text="Test project"
			subtitle-text={env.current?.testsDir ?? ''}
		></ui5-card-header>
		<div class="card-body">
			{#if env.current}
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
						status={env.current.envFile ? 'passed' : 'interrupted'}
						label={env.current.envFile ? '.env found' : 'no .env'}
					/>
				</div>
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
				<span class="muted">Values stay in sap-tests/.env and never reach the browser.</span>
			{/if}
		</div>
	</ui5-card>

	<ui5-card>
		<ui5-card-header
			slot="header"
			title-text="Suite"
			subtitle-text="{tests.length} tests in {specs.current?.length ?? 0} files"
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
					label="{issueCount} rule findings"
				/>
				<a href="/tests">Open tests & flows</a>
			</div>
		</div>
	</ui5-card>

	<ui5-card>
		<ui5-card-header
			slot="header"
			title-text="Last run"
			subtitle-text={lastRun ? when(lastRun.startedAt) : 'No runs yet'}
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
						? duration(Date.parse(lastRun.finishedAt) - Date.parse(lastRun.startedAt))
						: 'running…'}
				</span>
				<a href="/runs/{lastRun.id}">Open run</a>
			{:else}
				<span class="muted">Start with “Run demo” to see a live run.</span>
			{/if}
		</div>
	</ui5-card>
</div>

<ui5-panel
	header-text="Pilot stability: {stableCount} of {stab.current?.rows.length ??
		0} flows at {target} consecutive passes (guide §4.8)"
	fixed
>
	{#if stab.current && stab.current.rows.length}
		<ui5-table>
			<ui5-table-header-row slot="headerRow">
				<ui5-table-header-cell min-width="240px">Test</ui5-table-header-cell>
				<ui5-table-header-cell>Last</ui5-table-header-cell>
				<ui5-table-header-cell min-width="200px">Streak</ui5-table-header-cell>
				<ui5-table-header-cell>History</ui5-table-header-cell>
			</ui5-table-header-row>
			{#each stab.current.rows as row (row.key)}
				<ui5-table-row>
					<ui5-table-cell>
						<div>
							<a href="/flow?key={encodeURIComponent(row.key)}">{row.title}</a>
							<div class="muted mono">{row.file}</div>
						</div>
					</ui5-table-cell>
					<ui5-table-cell><StatusTag status={row.lastStatus} /></ui5-table-cell>
					<ui5-table-cell>
						<ui5-progress-indicator
							value={Math.min(100, (row.streak / target) * 100)}
							display-value="{row.streak} / {target}"
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
		<p class="muted">No finished runs yet. Skipped tests (missing SAP credentials) do not count.</p>
	{/if}
</ui5-panel>
