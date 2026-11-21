// The Mock PLC (sap-tests/mfs) for tests. Specs that need warehouse automation import `test` and
// `expect` from here instead of '../sap-plugin': the SAP locators stay available, so one test can
// run a scenario on the Mock PLC and then check in EWM what became of its HUs.
//
// The fixture reaches a running Mock PLC through its control API: MFS_EMULATOR_URL (and
// MFS_EMULATOR_TOKEN when it needs one), the same settings the app uses for a Mock PLC that runs
// elsewhere. With MFS_MOCK=1, playwright.config.ts starts a local one with the simulated EWM.
import { z } from 'zod';
import type { ScenarioInput } from '../mfs/scenario.mts';
import { test as base, expect } from './index';

const RunSchema = z.object({
	scenario: z.string(),
	title: z.string(),
	status: z.enum(['running', 'paused', 'passed', 'failed', 'stopped']),
	steps: z.array(
		z.object({
			title: z.string(),
			status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
			detail: z.string().optional()
		})
	),
	checks: z.array(z.object({ title: z.string(), ok: z.boolean(), detail: z.string().optional() })),
	/** Scenario HU name (A, B, …) → the HU number used in this run. */
	hus: z.record(z.string(), z.string()),
	error: z.string().optional()
});

/** A finished scenario run: its status, every step and expected result, and the HU numbers it used. */
export type ScenarioResult = z.infer<typeof RunSchema>;

export interface RunScenarioOptions {
	/** For the whole run. Default 120 s. */
	timeout?: number;
	/**
	 * Fail the test when the scenario does not pass (default). `false` returns the result
	 * instead, for tests that check how a scenario fails.
	 */
	expectPass?: boolean;
}

export interface MockPlc {
	/**
	 * Runs a scenario on the Mock PLC and follows it: each scenario step becomes a step of the test
	 * report, and the run is attached to the test. `scenario` is a file name in mfs/scenarios or a
	 * scenario written in the test.
	 */
	runScenario(
		scenario: string | (ScenarioInput & { name?: string }),
		options?: RunScenarioOptions
	): Promise<ScenarioResult>;
}

type Connection = { url: string; token: string | undefined };

function connection(): Connection | undefined {
	const url = process.env.MFS_EMULATOR_URL?.replace(/\/+$/, '');
	return url ? { url, token: process.env.MFS_EMULATOR_TOKEN || undefined } : undefined;
}

async function call(
	to: Connection,
	method: string,
	path: string,
	body?: unknown
): Promise<unknown> {
	const headers = new Headers();
	if (to.token) headers.set('authorization', `Bearer ${to.token}`);
	if (body !== undefined) headers.set('content-type', 'application/json');
	const response = await fetch(to.url + path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const data: unknown = await response.json();
	if (!response.ok) {
		const message = z.object({ error: z.string() }).safeParse(data);
		throw new Error(
			`Mock PLC: ${message.success ? message.data.error : `answered ${response.status}`}`
		);
	}
	return data;
}

const ended = (run: ScenarioResult) => ['passed', 'failed', 'stopped'].includes(run.status);

/** What went wrong, in a few lines: the failed step, the unmet expectations. */
function summary(run: ScenarioResult): string {
	const lines = [`Scenario "${run.title}": ${run.status}`];
	for (const step of run.steps)
		if (step.status === 'failed') lines.push(`  step failed: ${step.title}: ${step.detail ?? ''}`);
	for (const check of run.checks)
		if (!check.ok) lines.push(`  not met: ${check.title}: ${check.detail ?? ''}`);
	const hus = Object.entries(run.hus).map(([name, number]) => `${name} = ${number}`);
	if (hus.length) lines.push(`  HUs: ${hus.join(', ')}`);
	return lines.join('\n');
}

export const test = base.extend<{ mfs: MockPlc }>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	mfs: async ({}, use, testInfo) => {
		const to = connection();
		testInfo.skip(
			!to,
			'MFS_EMULATOR_URL is not set: start a Mock PLC (app page or `bun run mfs:server`) or run with MFS_MOCK=1'
		);
		if (!to) return;
		let running = false;
		await use({
			async runScenario(scenario, { timeout = 120_000, expectPass = true } = {}) {
				const deadline = Date.now() + timeout;
				const left = () => Math.max(1, deadline - Date.now());
				const body =
					typeof scenario === 'string'
						? { name: scenario }
						: { scenario: { ...scenario, name: undefined }, name: scenario.name };
				let run = RunSchema.parse(await call(to, 'POST', '/scenario/start', body));
				running = true;
				const refresh = async () => {
					run = RunSchema.nullable().parse(await call(to, 'GET', '/scenario')) ?? run;
					return run;
				};

				for (const [index, { title }] of run.steps.entries()) {
					await base.step(`Mock PLC: ${title}`, async () => {
						await expect
							.poll(
								async () => {
									const step = (await refresh()).steps[index];
									return ended(run) || step?.status === 'done' || step?.status === 'failed';
								},
								{ timeout: left(), intervals: [100], message: `scenario step "${title}"` }
							)
							.toBe(true);
						const step = run.steps[index];
						if (expectPass && step?.status === 'failed')
							throw new Error(step.detail ?? 'step failed');
					});
					if (run.status === 'failed' || run.status === 'stopped') break;
				}
				await base.step('Mock PLC: expected results', async () => {
					await expect
						.poll(async () => ended(await refresh()), {
							timeout: left(),
							intervals: [100],
							message: `scenario "${run.title}" to end`
						})
						.toBe(true);
				});
				running = false;

				await testInfo.attach(`Mock PLC scenario: ${run.title}`, {
					body: `${summary(run)}\n\n${JSON.stringify(run, null, 2)}`,
					contentType: 'text/plain'
				});
				if (expectPass && run.status !== 'passed') throw new Error(summary(run));
				return run;
			}
		});
		// A scenario still running when the test ends (timeout, failed check in the test) is
		// stopped, so the next test finds the Mock PLC free.
		if (running) await call(to, 'POST', '/scenario/stop', {}).catch(() => undefined);
	}
});

export { expect };
export type { Locator, Page } from './index';
