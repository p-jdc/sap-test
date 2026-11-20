import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

/** Guide §12, one entry per checklist line. */
export const CHECKLIST: { phase: string; items: { id: string; text: string }[] }[] = [
	{
		phase: 'Phase 1 – Pilot',
		items: [
			{ id: 'p1-system', text: 'Test system, test user and roles are ready' },
			{ id: 'p1-project', text: 'Project created and version 1.53.x confirmed' },
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
		phase: 'Phase 3 – Fork upgrade',
		items: [
			{ id: 'p3-measure', text: 'Fork measured and decision recorded' },
			{ id: 'p3-maintainer', text: 'Maintainer contacted' },
			{ id: 'p3-upgrade', text: 'Upgrade built, tested, published; pilot flows re-run' },
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

export function readChecked(): Record<string, boolean> {
	try {
		return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
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
