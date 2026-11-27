import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ToolInput } from './healer-rules.js';
import {
	BLANK_SEED,
	describePlannerTool,
	extraHosts,
	plannerDecision,
	sessionTarget,
	SIGNED_IN_SEED,
	webHost,
	type PlannerLimits
} from './planner-rules.js';

const MCP = 'mcp__playwright-test__';
/** An address with a login in it, which the planner must not be started on. */
const WITH_LOGIN = Object.assign(new URL('https://host.example/'), {
	username: 'user',
	password: 'x'
}).href;
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
	])('browser_navigate is refused for another host, with a reason: %s', (url, ok) => {
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

	test('saves one plan: a second save must use the name of the first', () => {
		const ownPlan = 'sap-tests/specs/first.plan.md';
		expect(decide('planner_save_plan', { fileName: ownPlan }, { ownPlan })).toEqual({
			allow: true,
			plan: ownPlan
		});
		const other = decide(
			'planner_save_plan',
			{ fileName: 'sap-tests/specs/second.plan.md' },
			{ ownPlan }
		);
		expect(other).toEqual({ allow: false, reason: `Save your plan again as ${ownPlan}.` });
	});
});

describe('browser_navigate in a session with its endpoints', () => {
	test('is refused for the same host on another scheme or port', () => {
		const own = { endpoints: new Set(['sdk.openui5.org:443']) };
		expect(decide('browser_navigate', { url: 'https://sdk.openui5.org/cart' }, own).allow).toBe(
			true
		);
		expect(decide('browser_navigate', { url: 'http://sdk.openui5.org/cart' }, own).allow).toBe(
			false
		);
	});
});

describe('sessionTarget', () => {
	const sap = {
		id: 'sap',
		title: 'SAP test system',
		setting: 'SAP_URL',
		address: 'https://sap.example:44300/sap/bc/ui2/flp'
	};

	test('without a system, starts on the address with the blank seed', () => {
		expect(sessionTarget({ address: ' https://sdk.openui5.org/cart ' })).toMatchObject({
			target: 'https://sdk.openui5.org/cart',
			limits: {
				seed: { file: BLANK_SEED, project: 'chromium' },
				hosts: new Set(['sdk.openui5.org'])
			}
		});
		expect(sessionTarget({})).toBe('Give the address of the application.');
	});

	test.each(['ftp://host.example/x', 'file:///etc/hosts', 'sap.example', WITH_LOGIN])(
		'refuses an address that is not a plain web address: %s',
		(address) => {
			expect(sessionTarget({ address })).toMatch(/^The address must start with http/);
			expect(sessionTarget({ address }, sap)).toMatch(/^The address must start with http/);
		}
	);

	test("with a system, starts signed in and stays on the system's host", () => {
		expect(sessionTarget({}, sap)).toMatchObject({
			target: 'SAP test system',
			limits: {
				seed: { file: SIGNED_IN_SEED, project: 'sap' },
				hosts: new Set(['sap.example:44300'])
			}
		});
		expect(sessionTarget({ address: 'https://sap.example:44300/sap/bc/gui' }, sap)).toMatchObject({
			target: 'SAP test system · https://sap.example:44300/sap/bc/gui'
		});
		// The session of one system is never used on another host, nor on another port of it.
		expect(sessionTarget({ address: 'https://elsewhere.example/' }, sap)).toBe(
			'The address must be on sap.example:44300, the host of SAP test system.'
		);
		expect(sessionTarget({ address: 'https://sap.example/' }, sap)).toMatch(/must be on/);
	});

	test('with a system, the address keeps the scheme of the system', () => {
		const https = { ...sap, address: 'https://sap.example/sap/bc/ui2/flp' };
		// Over http the session of an https system would travel unencrypted.
		expect(sessionTarget({ address: 'http://sap.example/sap/bc/gui' }, https)).toBe(
			'The address must start with https://sap.example, the address of SAP test system.'
		);
		expect(sessionTarget({ address: 'https://sap.example/sap/bc/gui' }, https)).toMatchObject({
			endpoints: new Set(['sap.example:443'])
		});
	});

	test('names what the proxy of the session connects to: the host on the port of the address', () => {
		expect(sessionTarget({ address: 'https://sdk.openui5.org/cart' })).toMatchObject({
			endpoints: new Set(['sdk.openui5.org:443'])
		});
		expect(sessionTarget({ address: 'http://localhost:8080/' })).toMatchObject({
			endpoints: new Set(['localhost:8080'])
		});
		expect(sessionTarget({}, sap)).toMatchObject({ endpoints: new Set(['sap.example:44300']) });
	});

	test('a system without an address cannot be planned on', () => {
		expect(sessionTarget({}, { ...sap, address: undefined })).toBe(
			'SAP test system has no address yet (SAP_URL, Settings page).'
		);
	});
});

describe('extraHosts', () => {
	test('names each host as the browser does and as the proxy does', () => {
		expect(
			extraHosts(
				' CDN.example.com, idp.example.com:443 ,sso.example.com:8443,http://old.example.com'
			)
		).toEqual({
			hosts: ['cdn.example.com', 'idp.example.com', 'sso.example.com:8443', 'old.example.com'],
			endpoints: [
				'cdn.example.com:443',
				'idp.example.com:443',
				'sso.example.com:8443',
				'old.example.com:80'
			]
		});
	});

	test('leaves out what is no host', () => {
		expect(extraHosts()).toEqual({ hosts: [], endpoints: [] });
		expect(extraHosts(', ,file:///etc,user:secret@example.com')).toEqual({
			hosts: [],
			endpoints: []
		});
	});
});

describe('webHost', () => {
	test('is the host of a web address only', () => {
		expect(webHost('https://host.example:44300/sap/bc/ui2/flp')).toBe('host.example:44300');
		expect(webHost('ftp://host.example')).toBeNull();
		expect(webHost(WITH_LOGIN)).toBeNull();
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
