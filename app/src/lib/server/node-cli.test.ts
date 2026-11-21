import { describe, expect, test } from 'vitest';
import { nodeWarning, playwrightNode, REQUIRED_NODE_MAJOR } from './node-cli.js';

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
