import { describe, expect, test } from 'vitest';
import { delimiter } from 'node:path';
import {
	APP_SECRETS,
	childEnv,
	nodeWarning,
	playwrightNode,
	REQUIRED_NODE_MAJOR
} from './node-cli.js';

describe('childEnv', () => {
	const parent = {
		PATH: ['/tmp/bun-node-123', '/usr/bin'].join(delimiter),
		SAP_URL: 'https://sap.example.com',
		...Object.fromEntries(APP_SECRETS.map((name) => [name, `secret of ${name}`]))
	};

	test("the app's secrets stay in the app", () => {
		const env = childEnv({}, parent);
		for (const name of APP_SECRETS) expect(env).not.toHaveProperty(name);
		expect(JSON.stringify(env)).not.toContain('secret of');
	});

	test("the IDoc receiver's SAP systems are empty unless given, so a run's dotenv can't fill them", () => {
		const env = childEnv({}, { ...parent, IDOC_EWM_PASSWORD: 'ewm-pw', IDOC_S4_URL: 'https://s4' });
		expect(env).toMatchObject({ IDOC_EWM_PASSWORD: '', IDOC_S4_URL: '', IDOC_S4_USER: '' });
		// The receiver gets them as extras.
		expect(childEnv({ IDOC_S4_URL: 'https://s4' }, parent).IDOC_S4_URL).toBe('https://s4');
	});

	test('everything else is passed on, without the node shim, plus the extras', () => {
		const env = childEnv({ SYSTEM: 'sap' }, parent);
		expect(env.SAP_URL).toBe('https://sap.example.com');
		expect(env.SYSTEM).toBe('sap');
		expect(env.PATH).toBe('/usr/bin');
	});
});

describe('nodeWarning', () => {
	test('the supported major passes', () => {
		expect(nodeWarning(`v${REQUIRED_NODE_MAJOR}.23.5`, '/usr/bin/node')).toBeNull();
	});

	test('another major names the version, the binary and the fix', () => {
		const warning = nodeWarning('v26.13.1', '/opt/homebrew/bin/node');
		expect(warning).toContain('v26.13.1');
		expect(warning).toContain('/opt/homebrew/bin/node');
		expect(warning).toContain(`only tested on Node ${REQUIRED_NODE_MAJOR}`);
		expect(warning).toContain('PLAYWRIGHT_NODE');
	});

	test('a major that only starts with the right digits is not mistaken for it', () => {
		expect(nodeWarning(`v${REQUIRED_NODE_MAJOR}0.1.0`, 'node')).not.toBeNull();
	});

	test('a node that cannot be run is reported', () => {
		expect(nodeWarning(null, '/missing/node')).toContain('/missing/node --version');
	});
});

test('playwrightNode reports the node it found', () => {
	const node = playwrightNode();
	expect(node.version).toMatch(/^v\d+\./);
	expect(node.warning).toBe(nodeWarning(node.version, node.path));
});
