import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

/**
 * Guide §12, one entry per checklist line. Phase 3 differs from the guide: instead of upgrading the
 * Playwright-SAP fork, the project moved to stock Playwright with the fork's locators as a plugin
 * (sap-tests/sap-plugin). The two replaced lines have new ids, so old ticks do not carry over.
 */
export const CHECKLIST: { phase: string; items: { id: string; text: string }[] }[] = [
	{
		phase: 'Phase 1 – Pilot',
		items: [
			{ id: 'p1-system', text: 'Test system, test user and roles are ready' },
			{ id: 'p1-project', text: 'Project created and Playwright version confirmed' },
			{ id: 'p1-flows', text: 'Three flows recorded, cleaned up and passed ten times in a row' },
			{ id: 'p1-helpers', text: 'Helper layer in use; WebGUI wait problems noted' }
		]
	},
	{
		phase: 'Phase 2 – Agent layer',
		items: [
			{ id: 'p2-security', text: 'Security approval for the AI provider is in place' },
			{ id: 'p2-mcp', text: 'MCP server connected and tried on one flow' },
			{ id: 'p2-rules', text: 'Rules file, reference test and three role files checked in' },
			{ id: 'p2-review', text: 'Review process agreed and followed' }
		]
	},
	{
		phase: 'Phase 3 – Off the fork',
		items: [
			{ id: 'p3-measure', text: 'Fork measured and decision recorded' },
			{
				id: 'p3-plugin',
				text: 'SAP locators run on stock Playwright as a plugin, with their own tests'
			},
			{ id: 'p3-rerun', text: 'Pilot flows re-run on stock Playwright' },
			{ id: 'p3-agents', text: 'Built-in agents set up and merged with own rules' }
		]
	},
	{
		phase: 'Phase 4 – SAP depth',
		items: [
			{ id: 'p4-praman', text: 'Praman tried on one Fiori flow' },
			{ id: 'p4-discovery', text: 'WebGUI discovery function works on real screens' },
			{ id: 'p4-ariba', text: 'Ariba suite with saved session state' },
			{ id: 'p4-ci', text: 'CI pipeline runs on schedule' }
		]
	}
];

const FILE = join(DATA_DIR, 'checklist.json');
const CheckedSchema = z.record(z.string(), z.boolean());

export function readChecked(): Record<string, boolean> {
	try {
		return existsSync(FILE) ? CheckedSchema.parse(JSON.parse(readFileSync(FILE, 'utf8'))) : {};
	} catch {
		return {};
	}
}

export function setChecked(id: string, checked: boolean) {
	const state = readChecked();
	state[id] = checked;
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(FILE, JSON.stringify(state, null, 2));
	return state;
}
