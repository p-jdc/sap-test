<script lang="ts">
	import MfsLayout from '#lib/components/mfs/MfsLayout.svelte';
	import ScenarioRun from '#lib/components/mfs/ScenarioRun.svelte';
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import {
		enterHu,
		ewmPicked,
		ewmRetrieve,
		getMfsScenarios,
		getMfsSetups,
		pauseScenario,
		resumeScenario,
		setDeviceStatus,
		setPlcFaults,
		startMfs,
		startScenario,
		stopMfs,
		stopScenario,
		watchMfsLive
	} from '#lib/remote/mfs.remote.js';
	import type { MfsMode, MfsTelegram } from '#lib/shared/mfs.js';

	const setups = getMfsSetups();
	const scenarioFiles = getMfsScenarios();
	const live = watchMfsLive();
	const snap = $derived(live.current);
	const status = $derived(snap?.status);
	const demo = $derived(status?.mode === 'demo');

	let setup = $state('sap-example');
	let mode = $state<MfsMode>('ewm');
	let speed = $state(1);
	/** Scenario to run right after starting; '' = free play. */
	let scenario = $state('');
	/** Scenario to run next on the running Mock PLC. */
	let nextScenario = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	let huNumber = $state('');
	let idPoint = $state<'OK' | 'NORD' | 'CONT' | 'WGHT'>('OK');
	let binOccupied = $state(false);
	let huCounter = 100001;

	/** Runs an action and shows its error instead of throwing. */
	async function run(action: () => Promise<unknown>) {
		error = null;
		busy = true;
		try {
			await action();
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	function nextHu(): string {
		const taken = new Set(snap?.state?.hus.map((hu) => hu.hu));
		while (taken.has(String(huCounter))) huCounter++;
		return String(huCounter++);
	}

	async function putIn() {
		const hu = huNumber.trim() || nextHu();
		await run(() => enterHu({ hu, idPoint, binOccupied }));
		if (!error) {
			huNumber = '';
			binOccupied = false;
		}
	}

	const select =
		<T extends string>(set: (value: T) => void) =>
		(e: CustomEvent<{ selectedOption: HTMLElement }>) => {
			const value = e.detail.selectedOption.dataset.value;
			if (value !== undefined) set(value as T);
		};

	const ID_RESULTS = [
		{ value: 'OK', text: 'Read and checked: OK' },
		{ value: 'NORD', text: 'No read (label not readable)' },
		{ value: 'CONT', text: 'Contour error (load sticks out)' },
		{ value: 'WGHT', text: 'Overweight' }
	] as const;
	const DEVICE_TYPES: Record<string, string> = {
		conveyor: 'Conveyor',
		'id-point': 'Identification point',
		'transfer-car': 'Transfer car',
		'stacker-crane': 'Stacker crane'
	};
	const EWM_STATUS: Record<string, string> = {
		routing: 'On its way',
		stored: 'Stored',
		'in-clearing': 'In clearing',
		'at-pick-point': 'At the pick point',
		shipped: 'At goods issue',
		error: 'Error'
	};

	/** Scenarios for the warehouse and mode chosen on the start card. */
	const startChoices = $derived(
		(scenarioFiles.current ?? []).filter((s) => s.setup === setup && s.modes.includes(mode))
	);
	const chosen = $derived(startChoices.find((s) => s.name === scenario));
	/** Scenarios the running Mock PLC can run (its own list, with reference problems left out). */
	const runChoices = $derived((snap?.scenarios ?? []).filter((s) => !s.problems?.length));
	const next = $derived(runChoices.find((s) => s.name === nextScenario) ?? runChoices[0]);
	const scenarioRun = $derived(snap?.run ?? undefined);
	const scenarioActive = $derived(
		scenarioRun?.status === 'running' || scenarioRun?.status === 'paused'
	);
	const RUN_STATUS = {
		running: { text: 'Running', design: 'Information' },
		paused: { text: 'Paused', design: 'Critical' },
		passed: { text: 'Passed', design: 'Positive' },
		failed: { text: 'Failed', design: 'Negative' },
		stopped: { text: 'Stopped', design: 'Neutral' }
	} as const;

	const pickPoint = $derived(snap?.setup?.points.find((p) => p.role === 'pick-point')?.id);
	const goodsIssue = $derived(snap?.setup?.points.find((p) => p.role === 'gi')?.id);
	const telegrams = $derived(
		(snap?.telegrams ?? [])
			.filter((t) => view.technical || (t.type !== 'ACK' && t.type !== 'LIFE') || t.note)
			.slice(-100)
			.toReversed()
	);
	const events = $derived((snap?.events ?? []).slice(-60).toReversed());
	const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
	const content = (t: MfsTelegram) =>
		Object.entries(t.fields)
			.filter(([, value]) => value !== '')
			.map(([name, value]) => `${name}=${value}`)
			.join(' ');
	const lifeAge = (at: number) =>
		at ? `${Math.round((Date.now() - at) / 1000)} s ago` : 'none yet';
</script>

<div class="page-head">
	<ui5-title level="H2">Mock PLC</ui5-title>
	{#if status?.running}
		<ui5-tag design="Information">
			{status.external ? 'Running on the server' : demo ? 'Demo running' : 'Waiting for EWM'}
		</ui5-tag>
	{:else if status}
		<ui5-tag design="Neutral">Stopped</ui5-tag>
	{/if}
	<span class="spacer"></span>
	{#if status?.running && !status.external}
		<ui5-button icon="stop" disabled={busy || undefined} onclick={() => run(() => stopMfs())}>
			Stop
		</ui5-button>
	{/if}
</div>

<p class="muted intro">
	Stands in for the PLCs of an automated warehouse: conveyors, identification point, transfer car
	and stacker cranes. EWM sends warehouse tasks, the Mock PLC moves the HUs and reports back, like
	the real automation. Use it on Dev and Qual systems that have no automation.
</p>

{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}
{#if status?.error}
	<ui5-message-strip design="Negative" hide-close-button>{status.error}</ui5-message-strip>
{/if}

{#if !snap}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{:else if !status?.running}
	<ui5-card class="start">
		<ui5-card-header slot="header" title-text="Start the Mock PLC"></ui5-card-header>
		<div class="card-body form">
			<ui5-label for="setup" show-colon>Warehouse</ui5-label>
			<ui5-select id="setup" onchange={select<string>((v) => (setup = v))}>
				{#each setups.current ?? [] as name (name)}
					<ui5-option data-value={name} selected={name === setup || undefined}>{name}</ui5-option>
				{/each}
			</ui5-select>

			<ui5-label for="mode" show-colon>Mode</ui5-label>
			<ui5-select id="mode" onchange={select<MfsMode>((v) => (mode = v))}>
				<ui5-option data-value="ewm" selected={mode === 'ewm' || undefined}>
					Wait for EWM to connect
				</ui5-option>
				<ui5-option data-value="demo" selected={mode === 'demo' || undefined}>
					Demo with a simulated EWM
				</ui5-option>
			</ui5-select>

			<ui5-label for="speed" show-colon>Speed</ui5-label>
			<ui5-select id="speed" onchange={select<string>((v) => (speed = Number(v)))}>
				{#each [1, 2, 4, 10] as factor (factor)}
					<ui5-option data-value={String(factor)} selected={factor === speed || undefined}>
						{factor === 1 ? 'Real time' : `${factor} times faster`}
					</ui5-option>
				{/each}
			</ui5-select>

			<ui5-label for="scenario" show-colon>Scenario</ui5-label>
			<ui5-select id="scenario" onchange={select<string>((v) => (scenario = v))}>
				<ui5-option data-value="" selected={!chosen || undefined}>None: free play</ui5-option>
				{#each startChoices as choice (choice.name)}
					<ui5-option data-value={choice.name} selected={choice.name === chosen?.name || undefined}>
						{choice.title}
					</ui5-option>
				{/each}
			</ui5-select>

			<span></span>
			<p class="muted">
				{#if chosen}
					{chosen.description}
				{:else if startChoices.length === 0 && mode === 'ewm'}
					No scenario runs against a real EWM yet; the first ones need the simulated EWM (Demo).
				{:else}
					Run a prepared scenario right after the start, or leave it at free play and act by hand.
				{/if}
			</p>

			<span></span>
			<p class="muted">
				{mode === 'demo'
					? 'A simulated EWM sends the warehouse tasks, so you can watch the whole flow without an SAP system.'
					: 'The PLCs open their ports and wait until EWM connects. The EWM communication channels must point to this machine.'}
			</p>

			<span></span>
			<div class="row">
				<ui5-button
					design="Emphasized"
					icon="play"
					disabled={busy || !setups.current?.length || undefined}
					onclick={() =>
						run(() =>
							startMfs({ setup, mode, speed, ...(chosen ? { scenario: chosen.name } : {}) })
						)}
				>
					Start
				</ui5-button>
			</div>
		</div>
	</ui5-card>
{:else}
	{#if runChoices.length || scenarioRun}
		<ui5-card class="block scenario">
			<ui5-card-header
				slot="header"
				title-text={scenarioRun ? `Scenario: ${scenarioRun.title}` : 'Scenarios'}
				subtitle-text={scenarioRun
					? (snap.scenarios?.find((s) => s.name === scenarioRun.scenario)?.description ?? '')
					: 'Prepared situations: what happens physically, and what EWM should do about it'}
			></ui5-card-header>
			<div class="card-body">
				<div class="row">
					{#if scenarioRun}
						<ui5-tag design={RUN_STATUS[scenarioRun.status].design}>
							{RUN_STATUS[scenarioRun.status].text}
						</ui5-tag>
					{/if}
					{#if scenarioActive}
						{#if scenarioRun?.status === 'paused'}
							<ui5-button icon="media-play" onclick={() => run(() => resumeScenario())}>
								Resume
							</ui5-button>
						{:else}
							<ui5-button icon="media-pause" onclick={() => run(() => pauseScenario())}>
								Pause
							</ui5-button>
						{/if}
						<ui5-button icon="stop" onclick={() => run(() => stopScenario())}>
							Stop scenario
						</ui5-button>
					{:else if runChoices.length}
						<ui5-select
							id="next-scenario"
							accessible-name="Scenario to run"
							onchange={select<string>((v) => (nextScenario = v))}
						>
							{#each runChoices as choice (choice.name)}
								<ui5-option
									data-value={choice.name}
									selected={choice.name === next?.name || undefined}
								>
									{choice.title}
								</ui5-option>
							{/each}
						</ui5-select>
						<ui5-button
							design="Emphasized"
							icon="play"
							disabled={busy || !next || undefined}
							onclick={() => next && run(() => startScenario({ name: next.name }))}
						>
							{scenarioRun ? 'Run' : 'Run scenario'}
						</ui5-button>
					{/if}
				</div>
				{#if scenarioRun}
					<ScenarioRun run={scenarioRun} />
				{:else if next}
					<p class="muted">{next.description}</p>
				{/if}
			</div>
		</ui5-card>
	{/if}

	{#if snap.setup}
		<ui5-card class="block">
			<ui5-card-header
				slot="header"
				title-text="Warehouse {snap.setup.name}"
				subtitle-text={view.technical
					? `Telegram layout ${snap.setup.interfaceType} · EWM id ${snap.setup.ewm}${status.speed && status.speed !== 1 ? ` · ${status.speed}× speed` : ''}`
					: snap.setup.description}
			></ui5-card-header>
			<div class="card-body">
				<MfsLayout setup={snap.setup} state={snap.state} />
			</div>
		</ui5-card>
	{/if}

	<div class="grid">
		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="Put an HU in at goods receipt"
				subtitle-text="It runs to the identification point, then EWM decides where it goes"
			></ui5-card-header>
			<div class="card-body form">
				<ui5-label for="hu" show-colon>HU number</ui5-label>
				<ui5-input
					id="hu"
					value={huNumber}
					placeholder="Leave empty for the next free number"
					oninput={(e: Event) => (huNumber = (e.target as HTMLInputElement).value)}
				></ui5-input>
				<ui5-label for="idpoint" show-colon>At the identification point</ui5-label>
				<ui5-select id="idpoint" onchange={select<typeof idPoint>((v) => (idPoint = v))}>
					{#each ID_RESULTS as result (result.value)}
						<ui5-option data-value={result.value} selected={result.value === idPoint || undefined}>
							{result.text}
						</ui5-option>
					{/each}
				</ui5-select>
				<span></span>
				<ui5-checkbox
					text="The crane finds the bin occupied"
					checked={binOccupied || undefined}
					onchange={(e: Event) => (binOccupied = (e.target as HTMLInputElement).checked)}
				></ui5-checkbox>
				<span></span>
				<div class="row">
					<ui5-button design="Emphasized" icon="add" disabled={busy || undefined} onclick={putIn}>
						Put in
					</ui5-button>
				</div>
			</div>
		</ui5-card>

		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="PLC connections"
				subtitle-text={demo ? 'Connected to the simulated EWM' : 'EWM connects to these ports'}
			></ui5-card-header>
			<div class="card-body">
				{#each snap.state?.plcs ?? [] as plc (plc.id)}
					<div class="line">
						<span class="name">{plc.id}</span>
						<ui5-tag design={plc.connected ? 'Positive' : 'Critical'}>
							{plc.connected ? 'Connected' : 'Not connected'}
						</ui5-tag>
						{#if view.technical || !demo}
							<span class="muted mono">port {plc.port}</span>
						{/if}
						{#if view.technical}
							<span class="muted">life telegram {lifeAge(plc.lastLifeAt)}</span>
						{/if}
					</div>
					<div class="actions">
						<ui5-button
							design="Transparent"
							tooltip="Withhold the next acknowledgement: EWM has to send its telegram again"
							disabled={!plc.connected || undefined}
							onclick={() => run(() => setPlcFaults({ plc: plc.id, dropAcks: 1 }))}
						>
							Skip an ack
						</ui5-button>
						<ui5-button
							design="Transparent"
							tooltip={plc.faults.stopLife
								? 'Send life telegrams again'
								: 'Stop sending life telegrams'}
							onclick={() =>
								run(() => setPlcFaults({ plc: plc.id, stopLife: !plc.faults.stopLife }))}
						>
							{plc.faults.stopLife ? 'Resume life' : 'Stop life'}
						</ui5-button>
						<ui5-button
							design="Transparent"
							tooltip="Close the connection, as if the cable were pulled"
							disabled={!plc.connected || undefined}
							onclick={() => run(() => setPlcFaults({ plc: plc.id, disconnect: true }))}
						>
							Disconnect
						</ui5-button>
					</div>
				{/each}
			</div>
		</ui5-card>

		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="Devices"
				subtitle-text="Switch one off to see how EWM reacts"
			></ui5-card-header>
			<div class="card-body">
				{#each snap.state?.devices ?? [] as device (device.id)}
					<div class="line">
						<span class="name">{device.id}</span>
						<span class="muted">{DEVICE_TYPES[device.type] ?? device.type} · {device.plc}</span>
						{#if device.active || device.queued}
							<span class="muted">
								{device.active} moving{device.queued ? `, ${device.queued} waiting` : ''}
							</span>
						{/if}
						<span class="spacer"></span>
						{#if device.type !== 'id-point'}
							<ui5-switch
								accessible-name="{device.id} running"
								checked={device.status === 'UP' || undefined}
								onchange={() =>
									run(() =>
										setDeviceStatus({
											id: device.id,
											status: device.status === 'UP' ? 'DOWN' : 'UP'
										})
									)}
							></ui5-switch>
						{/if}
					</div>
				{/each}
			</div>
		</ui5-card>

		{#if demo && snap.ewm}
			<ui5-card>
				<ui5-card-header
					slot="header"
					title-text="Simulated EWM"
					subtitle-text="Demo only: what a warehouse clerk would do in EWM"
				></ui5-card-header>
				<div class="card-body">
					{#each snap.ewm.hus as hu (hu.hu)}
						<div class="line">
							<span class="name">{hu.hu}</span>
							<ui5-tag
								design={hu.status === 'error'
									? 'Negative'
									: hu.status === 'in-clearing'
										? 'Critical'
										: 'Neutral'}
							>
								{EWM_STATUS[hu.status] ?? hu.status}
							</ui5-tag>
							<span class="muted">{hu.bin ?? hu.location}{hu.error ? ` · ${hu.error}` : ''}</span>
						</div>
						<div class="actions">
							{#if hu.status === 'stored' && goodsIssue}
								<ui5-button
									design="Transparent"
									onclick={() => run(() => ewmRetrieve({ hu: hu.hu, to: goodsIssue }))}
								>
									To goods issue
								</ui5-button>
							{/if}
							{#if hu.status === 'stored' && pickPoint}
								<ui5-button
									design="Transparent"
									onclick={() => run(() => ewmRetrieve({ hu: hu.hu, to: pickPoint }))}
								>
									To pick point
								</ui5-button>
							{/if}
							{#if hu.status === 'at-pick-point'}
								<ui5-button
									design="Transparent"
									onclick={() => run(() => ewmPicked({ hu: hu.hu }))}
								>
									Picking done
								</ui5-button>
							{/if}
						</div>
					{:else}
						<span class="muted">No HUs yet. Put one in at goods receipt.</span>
					{/each}
				</div>
			</ui5-card>
		{/if}
	</div>

	<div class="grid wide">
		<ui5-card>
			<ui5-card-header slot="header" title-text="What happened" subtitle-text="Newest first"
			></ui5-card-header>
			<div class="card-body scroll">
				{#each events as event (event.n)}
					<div><span class="muted mono">{time(event.at)}</span> {event.text}</div>
				{:else}
					<span class="muted">Nothing yet.</span>
				{/each}
			</div>
		</ui5-card>

		<ui5-card>
			<ui5-card-header
				slot="header"
				title-text="Telegrams"
				subtitle-text={view.technical
					? 'Newest first, with acknowledgements and life telegrams'
					: 'Newest first. Acknowledgements and life telegrams appear with “Technical details”.'}
			></ui5-card-header>
			<div class="card-body scroll">
				{#each telegrams as t (t.n)}
					<div class="telegram mono" class:note={t.note}>
						<span class="muted">{time(t.at)}</span>
						<span>{t.from} → {t.to}</span>
						<strong>{t.type}</strong>
						<span class="muted">#{t.seq || '----'}</span>
						<span>{content(t)}</span>
						{#if t.note}<em>{t.note}</em>{/if}
					</div>
				{:else}
					<span class="muted">No telegrams yet.</span>
				{/each}
			</div>
		</ui5-card>
	</div>
{/if}

<style>
	.intro {
		margin: 0 0 1rem;
		max-width: 50rem;
	}
	.start {
		max-width: 40rem;
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
	/* Buttons for the row above, indented under its name. */
	.actions {
		display: flex;
		flex-wrap: wrap;
		padding-left: 4.5rem;
		margin-top: -0.5rem;
	}
	.actions:empty {
		display: none;
	}
	.wide {
		grid-template-columns: repeat(auto-fit, minmax(min(480px, 100%), 1fr));
	}
	.scroll {
		max-height: 22rem;
		overflow: auto;
		gap: 0.25rem;
	}
	.telegram {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.telegram.note em {
		color: var(--sapCriticalTextColor);
	}
</style>
