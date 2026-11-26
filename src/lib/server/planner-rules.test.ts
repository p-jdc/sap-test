import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ToolInput } from './healer-rules.js';
import {
	BLANK_SEED,
	describePlannerTool,
	plannerDecision,
	SIGNED_IN_SEED,
	webHost,
	type PlannerLimits
} from './planner-rules.js';

const MCP = 'mcp__playwright-test__';
const allowed = new Set([
	'Read',
	`${MCP}planner_setup_page`,
	`${MCP}planner_save_plan`,
	`${MCP}browser_navigate`,
	`${MCP}browser_click`,
	`${MCP}browser_file_upload`,
	`${MCP}browser_run_code_unsafe`,
	`${MCP}browser_take_screenshot`
]);
let root = '';
const limits: PlannerLimits = {
	seed: { file: BLANK_SEED, project: 'chromium' },
	hosts: new Set(['sdk.openui5.org'])
};
const decide = (tool: string, input: ToolInput, own: Partial<PlannerLimits> = {}) =>
	plannerDecision(`${MCP}${tool}`, input, root, allowed, { ...limits, ...own });

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'planner-rules-'));
	mkdirSync(join(root, 'sap-tests/specs'), { recursive: true });
	mkdirSync(join(root, 'sap-tests/tests/_agents'), { recursive: true });
	writeFileSync(join(root, 'sap-tests/specs/a-person.plan.md'), '# theirs');
	writeFileSync(join(root, 'sap-tests/.env'), 'SAP_PASSWORD=x');
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('plannerDecision', () => {
	test('starts only the seed test of its session, in its project', () => {
		expect(decide('planner_setup_page', { seedFile: BLANK_SEED, project: 'chromium' })).toEqual({
			allow: true
		});
		expect(decide('planner_setup_page', { seedFile: SIGNED_IN_SEED, project: 'sap' }).allow).toBe(
			false
		);
		expect(decide('planner_setup_page', { seedFile: BLANK_SEED, project: 'sap' }).allow).toBe(
			false
		);
		// Without a seed file the server would write one of its own.
		expect(decide('planner_setup_page', {}).allow).toBe(false);
		expect(
			decide(
				'planner_setup_page',
				{ seedFile: SIGNED_IN_SEED, project: 'sap' },
				{ seed: { file: SIGNED_IN_SEED, project: 'sap' } }
			)
		).toEqual({ allow: true });
	});

	test.each([
		['https://sdk.openui5.org/test-resources/cart/index.html', true],
		['https://sdk.openui5.org:8443/x', false],
		['https://example.org/?q=what-the-screen-showed', false],
		['file:///etc/passwd', false],
		['javascript:alert(1)', false],
		['', false]
	])('opens only the hosts it was sent to: %s', (url, ok) => {
		expect(decide('browser_navigate', { url }).allow).toBe(ok);
	});

	test('acts on the page, but uploads no file and runs no code in the server', () => {
		expect(decide('browser_click', { element: 'Save', ref: 'e1' })).toEqual({ allow: true });
		expect(decide('browser_file_upload', { paths: ['sap-tests/.env'] }).allow).toBe(false);
		expect(decide('browser_run_code_unsafe', { code: 'x' }).allow).toBe(false);
		expect(decide('browser_take_screenshot', { filename: 'x.png' }).allow).toBe(false);
		expect(plannerDecision('Bash', {}, root, allowed, limits).allow).toBe(false);
		expect(
			plannerDecision('Read', { file_path: join(root, 'sap-tests/.env') }, root, allowed, limits)
				.allow
		).toBe(false);
	});

	test('saves a plan as a new plan file in specs', () => {
		const fileName = 'sap-tests/specs/cart-checkout.plan.md';
		expect(decide('planner_save_plan', { fileName })).toEqual({ allow: true, plan: fileName });
	});

	test.each([
		'sap-tests/specs/sub/cart.plan.md',
		'sap-tests/specs/../tests/fiori/a.spec.ts',
		'sap-tests/tests/fiori/cart.plan.md',
		'sap-tests/specs/cart.md',
		'sap-tests/specs/Cart Checkout.plan.md',
		'/etc/cart.plan.md'
	])('saves nothing elsewhere or under another kind of name: %s', (fileName) => {
		const decision = decide('planner_save_plan', { fileName });
		expect(decision.allow).toBe(false);
		expect(decision).not.toHaveProperty('plan');
	});

	test("does not replace a plan that is there, unless it is this session's", () => {
		const fileName = 'sap-tests/specs/a-person.plan.md';
		expect(decide('planner_save_plan', { fileName }).allow).toBe(false);
		expect(decide('planner_save_plan', { fileName }, { ownPlan: fileName })).toEqual({
			allow: true,
			plan: fileName
		});
	});
});

describe('webHost', () => {
	test('is the host of a web address only', () => {
		expect(webHost('https://host.example:44300/sap/bc/ui2/flp')).toBe('host.example:44300');
		expect(webHost('ftp://host.example')).toBeNull();
		expect(webHost('not an address')).toBeNull();
		expect(webHost()).toBeNull();
	});
});

describe('describePlannerTool', () => {
	test('names what the planner does in plain words', () => {
		expect(describePlannerTool(`${MCP}browser_click`, { element: 'Save button' })).toBe(
			'Clicks “Save button”'
		);
		expect(describePlannerTool(`${MCP}planner_setup_page`, {})).toBe('Opens the browser');
		expect(describePlannerTool(`${MCP}browser_tabs`, {})).toBe('browser_tabs');
	});
});
