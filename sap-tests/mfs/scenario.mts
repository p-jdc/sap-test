// Mock scenarios: a named script on top of a warehouse setup. Steps play what happens physically (an HU arrives,
// a device fails, a connection drops) and wait for the warehouse to react; expectations are checked at the end.
// The Mock PLC runs them itself, so the same file serves the app, tests and demos. Files: scenarios/<name>.json.
import { existsSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import {
	EVENT_FIELDS,
	EVENT_RESULTS,
	EventKindSchema,
	ScanResultSchema,
	type Emulator,
	type EmulatorEvent
} from './emulator.mts';
import type { FakeEwm } from './fake-ewm.mts';
import { UserError } from './http.mts';
import { isBinOf, readJson, type LoadedSetup } from './setup.mts';
import { checkValue } from './telegram.mts';

/** HUs are named A, B, … in a scenario; each run gives them real HU numbers. */
const Alias = z
	.string()
	.regex(/^[A-Z][A-Z0-9]{0,3}$/, 'HU names in a scenario are A, B, … (capital letters)');
/** `1.5s`, `800ms`. Scaled by the Mock PLC's speed where it stands for warehouse time (pauses). */
const Duration = z.string().regex(/^\d+(\.\d+)?(ms|s)$/, 'a duration like 2s or 500ms');
/** A point or bin id, `bin` for any rack bin, or a pattern with `*` (e.g. `A1-*`). */
const Location = z.string().min(1);

const HuCondition = z.strictObject({
	hu: Alias,
	at: Location.optional(),
	notAt: Location.optional(),
	/** The HU is on this device right now (e.g. riding the transfer car). */
	movingOn: z.string().optional(),
	/** The HU has left the automated area (goods issue). */
	left: z.boolean().optional(),
	/** Status in the simulated EWM (demo only): stored, in-clearing, at-pick-point, shipped. */
	ewm: z.string().optional()
});
const TelegramCondition = z.strictObject({
	telegram: z.strictObject({
		from: z.string().optional(),
		to: z.string().optional(),
		type: z.string(),
		fields: z.record(z.string(), z.string()).optional(),
		/** Part of the protocol note (resent, repeated sequence number, …). */
		note: z.string().optional()
	}),
	/** Exactly this many matching telegrams since the scenario started; without it, at least one. */
	count: z.number().int().min(0).optional()
});
/**
 * An event of the Mock PLC since the scenario started, by its kind and fields (see EventKindSchema). Matched on
 * fields, never on the event's text: the text is for people and may change.
 */
const EventCondition = z.strictObject({
	event: z.strictObject({
		kind: EventKindSchema,
		hu: Alias.optional(),
		plc: z.string().optional(),
		device: z.string().optional(),
		/** Locations, as in HU conditions: an id, `bin`, or a pattern with `*`. */
		from: Location.optional(),
		to: Location.optional(),
		point: Location.optional(),
		task: z.string().optional(),
		/** The emulator's name for the result (noRoute, NORD, …), not the code in the telegram. */
		result: z.string().optional(),
		status: z.enum(['UP', 'DOWN']).optional(),
		/** The telegram type (telegram-queued, -not-sent, -ignored). */
		telegram: z.string().optional(),
		/** The report the layout has no telegram for (no-telegram): task, confirmation, scan, status. */
		message: z.string().optional()
	}),
	/** Exactly this many matching events since the scenario started; without it, at least one. */
	count: z.number().int().min(0).optional()
});
type EventWanted = z.infer<typeof EventCondition>['event'];
const Condition = z.union([HuCondition, TelegramCondition, EventCondition]);

const Title = z.string().min(1).optional();
const StepSchema = z.union([
	z.strictObject({
		title: Title,
		enter: Alias,
		at: z.string().optional(),
		idPoint: ScanResultSchema.optional(),
		binOccupied: z.boolean().optional()
	}),
	z.strictObject({ title: Title, wait: Condition, timeout: Duration.optional() }),
	z.strictObject({ title: Title, device: z.string(), status: z.enum(['UP', 'DOWN']) }),
	z.strictObject({
		title: Title,
		faults: z.string(),
		dropAcks: z.number().int().min(0).optional(),
		stopLife: z.boolean().optional(),
		disconnect: z.boolean().optional()
	}),
	z.strictObject({
		title: Title,
		ewm: z.enum(['retrieve', 'picked']),
		hu: Alias,
		to: z.string().optional()
	}),
	z.strictObject({ title: Title, pause: Duration }),
	z.strictObject({ title: Title, check: Condition })
]);

export const ScenarioSchema = z.strictObject({
	title: z.string().min(1),
	description: z.string(),
	setup: z.string().min(1),
	/** `demo`: needs the simulated EWM. `ewm`: also runs against a real EWM. */
	modes: z.array(z.enum(['demo', 'ewm'])).min(1),
	/** Start from an empty warehouse (demo only: a real EWM keeps its stock). */
	fresh: z.boolean().default(true),
	steps: z.array(StepSchema).min(1),
	expect: z.array(Condition).default([])
});

export type Scenario = z.infer<typeof ScenarioSchema> & { name: string };
/** A scenario as written (in a file or in a test): `fresh` and `expect` may be left out. */
export type ScenarioInput = z.input<typeof ScenarioSchema>;
type Step = z.infer<typeof StepSchema>;
type ConditionDef = z.infer<typeof Condition>;
export type ScenarioInfo = Pick<Scenario, 'name' | 'title' | 'description' | 'setup' | 'modes'> & {
	/** The HUs that enter in the scenario, by their names (A, B, …). */
	hus: string[];
	/** Whether a run needs a number for every one of them: true against a real EWM, which must know the HUs. */
	needsHuNumbers: boolean;
};

/**
 * HU numbers for a run: scenario HU name → number. Against a real EWM every HU needs one, because EWM must
 * know the HU before it arrives; in the demo they are optional and the rest get the next free numbers.
 */
export const HuNumbersSchema = z.record(Alias, z.string().min(1));
export type HuNumbers = z.infer<typeof HuNumbersSchema>;

/** The names of the HUs that enter in a scenario, in order. */
export function enteringHus(scenario: Pick<Scenario, 'steps'>): string[] {
	return [...new Set(scenario.steps.flatMap((step) => ('enter' in step ? [step.enter] : [])))];
}

const scenariosDir = new URL('./scenarios/', import.meta.url);
export const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function loadScenario(name: string): Scenario {
	if (!SCENARIO_NAME.test(name)) throw new UserError(`"${name}" is not a scenario name`);
	const file = new URL(`${name}.json`, scenariosDir);
	if (!existsSync(file)) throw new UserError(`there is no scenario "${name}"`, 404);
	return { name, ...readJson(file, ScenarioSchema) };
}

/** Every scenario file, checked. A broken file fails loudly instead of disappearing from the list. */
export function listScenarios(): Scenario[] {
	if (!existsSync(scenariosDir)) return [];
	return (
		readdirSync(scenariosDir)
			.filter((file) => file.endsWith('.json'))
			.map((file) => loadScenario(file.slice(0, -'.json'.length)))
			// A new array from map, so sorting in place changes nothing else (toSorted needs ES2023 types).
			// oxlint-disable-next-line unicorn/no-array-sort
			.sort((a, b) => a.title.localeCompare(b.title))
	);
}

/** Problems with a scenario's references to its setup: unknown points, devices, PLCs, HUs used before they enter. */
export function validateScenario(scenario: Scenario, setup: LoadedSetup): string[] {
	const errors: string[] = [];
	if (scenario.setup !== setup.name)
		return [`written for setup "${scenario.setup}", not "${setup.name}"`];
	const points = new Set(setup.points.map((point) => point.id));
	const devices = new Set(setup.devices.map((device) => device.id));
	const plcs = new Set(setup.plcs.map((plc) => plc.id));
	const entered = new Set<string>();
	const huKnown = (where: string, hu: string) => {
		if (!entered.has(hu)) errors.push(`${where}: HU ${hu} is used before it enters`);
	};
	const checkCondition = (where: string, condition: ConditionDef) => {
		if ('hu' in condition) {
			huKnown(where, condition.hu);
			if (condition.movingOn && !devices.has(condition.movingOn))
				errors.push(`${where}: unknown device "${condition.movingOn}"`);
			if (condition.ewm && !scenario.modes.every((mode) => mode === 'demo'))
				errors.push(`${where}: an EWM status can only be checked in demo mode`);
		}
		if ('event' in condition) {
			const want = condition.event;
			// A field the kind never carries, or a result it never reports, would never match: a check for
			// "this did not happen" (count 0) would then always pass.
			const { kind, ...fields } = want;
			const carried: readonly string[] = EVENT_FIELDS[kind];
			for (const field of Object.keys(fields))
				if (!carried.includes(field))
					errors.push(
						`${where}: a ${kind} event has no "${field}"${carried.length > 0 ? ` (it has ${carried.join(', ')})` : ''}`
					);
			const results = EVENT_RESULTS[kind];
			if (want.result && results && !results.includes(want.result))
				errors.push(
					`${where}: a ${kind} event has no result "${want.result}" (it reports ${results.join(', ')})`
				);
			if (want.hu) huKnown(where, want.hu);
			if (want.device && !devices.has(want.device))
				errors.push(`${where}: unknown device "${want.device}"`);
			if (want.plc && !plcs.has(want.plc)) errors.push(`${where}: unknown PLC "${want.plc}"`);
		}
	};
	scenario.steps.forEach((step, index) => {
		const where = `step ${index + 1}`;
		if ('enter' in step) {
			if (step.at && !points.has(step.at)) errors.push(`${where}: unknown point "${step.at}"`);
			entered.add(step.enter);
		}
		if ('wait' in step) checkCondition(where, step.wait);
		if ('check' in step) checkCondition(where, step.check);
		if ('device' in step && !devices.has(step.device))
			errors.push(`${where}: unknown device "${step.device}"`);
		if ('faults' in step && !plcs.has(step.faults))
			errors.push(`${where}: unknown PLC "${step.faults}"`);
		if ('ewm' in step) {
			huKnown(where, step.hu);
			if (!scenario.modes.every((mode) => mode === 'demo'))
				errors.push(
					`${where}: EWM actions need the simulated EWM, so the scenario must be demo only`
				);
			if (step.to && !points.has(step.to)) errors.push(`${where}: unknown point "${step.to}"`);
		}
	});
	scenario.expect.forEach((condition, index) =>
		checkCondition(`expectation ${index + 1}`, condition)
	);
	return errors;
}

// --- running -------------------------------------------------------------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'paused' | 'passed' | 'failed' | 'stopped';

export interface ScenarioRun {
	scenario: string;
	title: string;
	status: RunStatus;
	steps: { title: string; status: StepStatus; detail?: string }[];
	checks: { title: string; ok: boolean; detail?: string }[];
	/** Scenario HU name → the HU number used in this run. */
	hus: Record<string, string>;
	startedAt: string;
	finishedAt?: string;
	error?: string;
}

class Stopped extends Error {}

const ms = (duration: string) => {
	const value = Number.parseFloat(duration);
	return duration.endsWith('ms') ? value : value * 1000;
};
const sleep = (time: number) =>
	new Promise<void>((done) => {
		setTimeout(done, time);
	});

/** `*` matches any text; `bin` matches any rack bin of the setup. */
function locationMatches(
	setup: LoadedSetup,
	location: string | undefined,
	pattern: string
): boolean {
	if (location === undefined) return false;
	if (pattern === 'bin')
		return setup.devices.some(
			(device) => device.type === 'stacker-crane' && isBinOf(device, location)
		);
	const regex = new RegExp(
		`^${pattern
			.split('*')
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*')}$`
	);
	return regex.test(location);
}

export class ScenarioRunner {
	#emulator: Emulator;
	#ewm: FakeEwm | undefined;
	#speed: number;
	#waitTimeoutMs: number;
	#settleMs: number;
	#run: ScenarioRun | undefined;
	#paused = false;
	#stopped = false;
	#logFrom = 0;
	#eventFrom = 0;

	constructor(options: {
		emulator: Emulator;
		ewm?: FakeEwm;
		speed?: number;
		waitTimeoutMs?: number;
		/** How long the expectations may take to come true after the last step. */
		settleMs?: number;
	}) {
		this.#emulator = options.emulator;
		this.#ewm = options.ewm;
		this.#speed = options.speed ?? 1;
		this.#waitTimeoutMs = options.waitTimeoutMs ?? 120_000;
		this.#settleMs = options.settleMs ?? 2000;
	}

	get mode(): 'demo' | 'ewm' {
		return this.#ewm ? 'demo' : 'ewm';
	}

	/** The scenarios this Mock PLC can run: its setup, its mode, and no reference errors. */
	available(): (ScenarioInfo & { problems: string[] })[] {
		return listScenarios()
			.filter(
				(scenario) =>
					scenario.setup === this.#emulator.setup.name && scenario.modes.includes(this.mode)
			)
			.map((scenario) => {
				const { name, title, description, setup, modes } = scenario;
				return {
					name,
					title,
					description,
					setup,
					modes,
					hus: enteringHus(scenario),
					needsHuNumbers: this.mode === 'ewm',
					problems: validateScenario(scenario, this.#emulator.setup)
				};
			});
	}

	state(): ScenarioRun | undefined {
		return this.#run && structuredClone(this.#run);
	}

	/**
	 * Starts a scenario (by file name, or given) and returns at once; the run goes on in the background. Returns
	 * the run's first state. `hus` gives HUs their numbers (see HuNumbersSchema).
	 */
	start(nameOrScenario: string | Scenario, hus: HuNumbers = {}): ScenarioRun {
		if (this.#run && (this.#run.status === 'running' || this.#run.status === 'paused'))
			throw new UserError(`scenario "${this.#run.title}" is still running; stop it first`, 409);
		const scenario =
			typeof nameOrScenario === 'string' ? loadScenario(nameOrScenario) : nameOrScenario;
		const name = scenario.name;
		if (!scenario.modes.includes(this.mode))
			throw new UserError(
				`"${scenario.title}" needs ${scenario.modes.includes('demo') ? 'the demo (simulated EWM)' : 'a real EWM'}`,
				409
			);
		const problems = [
			...validateScenario(scenario, this.#emulator.setup),
			...this.#huNumberProblems(scenario, hus)
		];
		if (problems.length > 0)
			throw new UserError(`scenario "${name}" is invalid:\n- ${problems.join('\n- ')}`);
		this.#paused = false;
		this.#stopped = false;
		const run: ScenarioRun = {
			scenario: name,
			title: scenario.title,
			status: 'running',
			steps: scenario.steps.map((step) => ({ title: this.#stepTitle(step), status: 'pending' })),
			checks: [],
			hus: { ...hus },
			startedAt: new Date().toISOString()
		};
		this.#run = run;
		void this.#execute(scenario, run);
		return structuredClone(run);
	}

	#huNumberProblems(scenario: Scenario, hus: HuNumbers): string[] {
		const problems: string[] = [];
		const entering = enteringHus(scenario);
		const numbers = Object.values(hus);
		for (const [alias, number] of Object.entries(hus)) {
			if (!entering.includes(alias)) problems.push(`HU number for ${alias}: no HU ${alias} enters`);
			if (numbers.filter((other) => other === number).length > 1)
				problems.push(`HU number ${number} is given to more than one HU`);
			// Checked before the run, not when the HU enters: against a real EWM the HUs before it would be booked.
			try {
				checkValue(this.#emulator.setup.layout, 'scan', 'hu', number);
				checkValue(this.#emulator.setup.layout, 'task', 'hu', number);
			} catch (error) {
				problems.push(
					`HU number ${number} (${alias}) cannot travel in a telegram: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			const there = this.#emulator.hu(number);
			// A fresh demo run empties the warehouse first; otherwise the HU would meet itself.
			if (there && !there.left && !(scenario.fresh && this.#ewm))
				problems.push(
					`HU ${number} (${alias}) is already in the layout, at ${there.at ?? 'a device'}`
				);
		}
		const missing = entering.filter((alias) => !hus[alias]);
		if (this.mode === 'ewm' && missing.length > 0)
			problems.push(
				`against a real EWM every HU needs a number that EWM knows: none given for ${missing.join(', ')}`
			);
		return [...new Set(problems)];
	}

	pause(): void {
		if (this.#run?.status !== 'running') throw new UserError('no scenario is running', 409);
		this.#paused = true;
		this.#run.status = 'paused';
	}

	resume(): void {
		if (this.#run?.status !== 'paused') throw new UserError('no scenario is paused', 409);
		this.#paused = false;
		this.#run.status = 'running';
	}

	stop(): void {
		if (this.#run?.status !== 'running' && this.#run?.status !== 'paused')
			throw new UserError('no scenario is running', 409);
		this.#stopped = true;
		this.#paused = false;
	}

	async #execute(scenario: Scenario, run: ScenarioRun) {
		if (scenario.fresh && this.#ewm) {
			this.#emulator.reset();
			this.#ewm.reset();
		}
		this.#logFrom = this.#emulator.log().at(-1)?.n ?? 0;
		this.#eventFrom = this.#emulator.events().at(-1)?.n ?? 0;
		let index = 0;
		try {
			for (; index < scenario.steps.length; index++) {
				const step = scenario.steps[index];
				const state = run.steps[index];
				if (!step || !state) break;
				// Sequential by nature: each step acts on what the previous one left.
				await this.#gate();
				state.status = 'running';
				state.detail = await this.#step(step, run);
				state.status = 'done';
			}
			// EWM learns what happened from telegrams, a moment after the warehouse did it: give the expectations
			// that moment, then check them all.
			await this.#settle(scenario.expect, run);
			run.checks = scenario.expect.map((condition) => {
				const { ok, detail } = this.#evaluate(condition, run);
				return { title: this.#describe(condition, run), ok, detail };
			});
			run.status = run.checks.every((check) => check.ok) ? 'passed' : 'failed';
		} catch (error) {
			const state = run.steps[index];
			if (error instanceof Stopped) {
				run.status = 'stopped';
				if (state) state.status = 'skipped';
			} else {
				run.status = 'failed';
				run.error = error instanceof Error ? error.message : String(error);
				if (state) {
					state.status = 'failed';
					state.detail = run.error;
				}
			}
			for (const rest of run.steps.slice(index + 1)) rest.status = 'skipped';
		}
		run.finishedAt = new Date().toISOString();
	}

	/** Holds while paused; throws when stopped. */
	async #gate() {
		while (this.#paused && !this.#stopped) {
			await sleep(50);
		}
		if (this.#stopped) throw new Stopped();
	}

	#number(run: ScenarioRun, alias: string): string {
		const known = run.hus[alias];
		if (known) return known;
		let candidate = 300_001;
		const taken = new Set(Object.values(run.hus));
		while (taken.has(String(candidate)) || this.#emulator.hu(String(candidate))) candidate++;
		run.hus[alias] = String(candidate);
		return String(candidate);
	}

	#hu(run: ScenarioRun, alias: string): string {
		const number = run.hus[alias];
		if (!number) throw new Error(`HU ${alias} has not entered yet`);
		return number;
	}

	/** `{A}` in a text becomes HU A's number. */
	#fill(run: ScenarioRun, text: string): string {
		return text.replace(
			/\{([A-Z][A-Z0-9]{0,3})\}/g,
			(match, alias: string) => run.hus[alias] ?? match
		);
	}

	async #step(step: Step, run: ScenarioRun): Promise<string | undefined> {
		if ('enter' in step) {
			const hu = this.#number(run, step.enter);
			this.#emulator.enter(hu, step.at, {
				...(step.idPoint ? { idPoint: step.idPoint } : {}),
				...(step.binOccupied ? { binOccupied: true } : {})
			});
			return `HU ${step.enter} is ${hu}`;
		}
		if ('wait' in step)
			return this.#waitFor(step.wait, run, step.timeout ? ms(step.timeout) : this.#waitTimeoutMs);
		if ('device' in step) {
			this.#emulator.setDeviceStatus(step.device, step.status);
			return undefined;
		}
		if ('faults' in step) {
			const { title: _title, faults, ...settings } = step;
			this.#emulator.setFaults(faults, settings);
			return undefined;
		}
		if ('ewm' in step) {
			if (!this.#ewm) throw new Error('this step needs the simulated EWM');
			const hu = this.#hu(run, step.hu);
			if (step.ewm === 'picked') this.#ewm.picked(hu);
			else this.#ewm.retrieve(hu, step.to ?? 'GI');
			return undefined;
		}
		if ('pause' in step) {
			const until = Date.now() + ms(step.pause) / this.#speed;
			while (Date.now() < until) {
				await this.#gate();
				await sleep(Math.min(50, until - Date.now()));
			}
			return undefined;
		}
		const { ok, detail } = this.#evaluate(step.check, run);
		if (!ok) throw new Error(`check failed${detail ? `: ${detail}` : ''}`);
		return detail;
	}

	/**
	 * Resolves as soon as the condition holds. Checked on every event and telegram of the Mock PLC, not by polling:
	 * the next step then runs before the warehouse moves on, so "when the HU is on its way, the crane fails" lands
	 * at the same moment at any speed. A timer covers pause, stop and the timeout.
	 */
	#waitFor(condition: ConditionDef, run: ScenarioRun, limit: number): Promise<string | undefined> {
		return new Promise((resolve, reject) => {
			const deadline = Date.now() + limit;
			let finished = false;
			const finish = (done: () => void) => {
				if (finished) return;
				finished = true;
				offEvents();
				offLog();
				clearInterval(timer);
				done();
			};
			const check = () => {
				if (this.#stopped) return finish(() => reject(new Stopped()));
				if (this.#paused) return;
				const { ok, detail } = this.#evaluate(condition, run);
				if (ok) return finish(() => resolve(detail));
				if (Date.now() > deadline)
					finish(() =>
						reject(
							new Error(
								`not reached within ${Math.round(limit / 1000)} s${detail ? `: ${detail}` : ''}`
							)
						)
					);
			};
			const offEvents = this.#emulator.onEvent(check);
			const offLog = this.#emulator.onLog(check);
			const timer = setInterval(check, 100);
			check();
		});
	}

	/** Resolves when every expectation holds, or after the settling time; checked on each event and telegram. */
	#settle(expectations: ConditionDef[], run: ScenarioRun): Promise<void> {
		return new Promise((resolve) => {
			const deadline = Date.now() + this.#settleMs;
			let finished = false;
			const check = () => {
				if (finished) return;
				const all = expectations.every((condition) => this.#evaluate(condition, run).ok);
				if (!all && Date.now() <= deadline) return;
				finished = true;
				offEvents();
				offLog();
				clearInterval(timer);
				resolve();
			};
			const offEvents = this.#emulator.onEvent(check);
			const offLog = this.#emulator.onLog(check);
			const timer = setInterval(check, 50);
			check();
		});
	}

	#evaluate(condition: ConditionDef, run: ScenarioRun): { ok: boolean; detail?: string } {
		const setup = this.#emulator.setup;
		if ('hu' in condition) {
			const number = run.hus[condition.hu];
			const hu = number ? this.#emulator.hu(number) : undefined;
			const where = hu?.moving
				? `on ${hu.moving.device}`
				: hu?.left
					? 'gone'
					: `at ${hu?.at ?? 'nowhere'}`;
			const failures: string[] = [];
			if (condition.at && !locationMatches(setup, hu?.at, condition.at))
				failures.push(`is ${where}`);
			if (condition.notAt && locationMatches(setup, hu?.at, condition.notAt))
				failures.push(`is ${where}`);
			if (condition.movingOn && hu?.moving?.device !== condition.movingOn)
				failures.push(`is ${where}`);
			if (condition.left !== undefined && (hu?.left ?? false) !== condition.left)
				failures.push(`is ${where}`);
			if (condition.ewm) {
				const status = number ? this.#ewm?.hu(number)?.status : undefined;
				if (status !== condition.ewm) failures.push(`EWM status ${status ?? 'unknown'}`);
			}
			return failures.length === 0
				? { ok: true, detail: `${condition.hu} (${number}) ${where}` }
				: {
						ok: false,
						detail: `${condition.hu} (${number ?? 'not entered'}) ${[...new Set(failures)].join(', ')}`
					};
		}
		if ('telegram' in condition) {
			const want = condition.telegram;
			const matching = this.#emulator
				.log(this.#logFrom)
				.filter(
					(entry) =>
						entry.type === want.type &&
						(!want.from || entry.from === want.from) &&
						(!want.to || entry.to === want.to) &&
						(!want.note || (entry.note ?? '').includes(want.note)) &&
						Object.entries(want.fields ?? {}).every(
							([name, value]) => entry.fields[name] === this.#fill(run, value)
						)
				);
			const ok =
				condition.count === undefined ? matching.length > 0 : matching.length === condition.count;
			return { ok, detail: `${matching.length} found` };
		}
		const matching = this.#emulator
			.events(this.#eventFrom)
			.filter((event) => this.#eventMatches(event, condition.event, run));
		const ok =
			condition.count === undefined ? matching.length > 0 : matching.length === condition.count;
		const last = matching.at(-1);
		return {
			ok,
			detail: condition.count === undefined && last ? last.text : `${matching.length} found`
		};
	}

	#eventMatches(event: EmulatorEvent, want: EventWanted, run: ScenarioRun): boolean {
		const setup = this.#emulator.setup;
		if (event.kind !== want.kind) return false;
		// An HU that has not entered yet has no number, so nothing can match it.
		if (want.hu && (!run.hus[want.hu] || event.hu !== run.hus[want.hu])) return false;
		if (want.from && !locationMatches(setup, event.from, want.from)) return false;
		if (want.to && !locationMatches(setup, event.to, want.to)) return false;
		if (want.point && !locationMatches(setup, event.point, want.point)) return false;
		return (['plc', 'device', 'task', 'result', 'status', 'telegram', 'message'] as const).every(
			(field) => want[field] === undefined || event[field] === want[field]
		);
	}

	#stepTitle(step: Step): string {
		if (step.title) return step.title;
		if ('enter' in step) {
			const result: Record<string, string> = {
				NORD: ', the ID point cannot read it',
				CONT: ', with a contour error',
				WGHT: ', overweight'
			};
			return `HU ${step.enter} arrives at ${step.at ?? 'goods receipt'}${step.idPoint ? (result[step.idPoint] ?? '') : ''}${step.binOccupied ? ', its bin will be occupied' : ''}`;
		}
		if ('wait' in step) return `Wait until ${this.#describe(step.wait)}`;
		if ('device' in step)
			return `${step.device} ${step.status === 'DOWN' ? 'fails' : 'runs again'}`;
		if ('faults' in step) {
			const what = [
				step.dropAcks ? `withholds ${step.dropAcks} acknowledgement(s)` : '',
				step.stopLife === true
					? 'stops life telegrams'
					: step.stopLife === false
						? 'resumes life telegrams'
						: '',
				step.disconnect ? 'drops the connection' : ''
			].filter(Boolean);
			return `${step.faults} ${what.join(', ') || 'clears its faults'}`;
		}
		if ('ewm' in step)
			return step.ewm === 'picked'
				? `EWM: picking of ${step.hu} is done`
				: `EWM: HU ${step.hu} out to ${step.to ?? 'GI'}`;
		if ('pause' in step) return `Pause ${step.pause}`;
		return `Check: ${this.#describe(step.check)}`;
	}

	#describe(condition: ConditionDef, run?: ScenarioRun): string {
		const fill = (text: string) => (run ? this.#fill(run, text) : text);
		if ('hu' in condition) {
			const parts = [
				condition.at ? (condition.at === 'bin' ? 'is in a bin' : `is at ${condition.at}`) : '',
				condition.notAt ? `is not at ${condition.notAt}` : '',
				condition.movingOn ? `is on ${condition.movingOn}` : '',
				condition.left === true ? 'has left' : condition.left === false ? 'has not left' : '',
				condition.ewm ? `is ${condition.ewm} in EWM` : ''
			].filter(Boolean);
			return `${condition.hu} ${parts.join(' and ')}`;
		}
		if ('telegram' in condition) {
			const want = condition.telegram;
			const fields = Object.entries(want.fields ?? {})
				.map(([name, value]) => `${name}=${fill(value)}`)
				.join(' ');
			const route = [want.from, want.to].some(Boolean)
				? ` ${want.from ?? '*'} → ${want.to ?? '*'}`
				: '';
			const count = condition.count === undefined ? '' : ` exactly ${condition.count} time(s)`;
			return `telegram ${want.type}${route}${fields ? ` with ${fields}` : ''}${want.note ? ` (${want.note})` : ''}${count}`;
		}
		const want = condition.event;
		const fields = Object.entries(want)
			.filter(([name]) => name !== 'kind')
			.map(([name, value]) => {
				const number = name === 'hu' && run ? run.hus[value] : undefined;
				return `${name}=${value}${number ? ` (${number})` : ''}`;
			})
			.join(' ');
		const count = condition.count === undefined ? '' : ` exactly ${condition.count} time(s)`;
		return `event ${want.kind}${fields ? ` with ${fields}` : ''}${count}`;
	}
}
