/**
 * Turns the script of an Octane test into the steps of a test plan. A manual test's script has one
 * step per line: `- ` an action, `- ?` a validation (what to check after the step before it) and
 * `- @` a call of another test. A Gherkin test's script is its feature file.
 */

/** One step of a plan: what to do, then what to check. Either part can be empty. */
export interface PlanStep {
	action: string;
	expect: string[];
}

/** One test of a plan: the manual test itself, or one scenario of a Gherkin test. */
export interface PlanScenario {
	name: string;
	steps: PlanStep[];
	/** A scenario outline's examples, the table lines as written. */
	examples: string[];
}

export interface ParsedScript {
	scenarios: PlanScenario[];
	/** The ids or names of the tests that call steps name, in their order. */
	calls: string[];
}

const join = (a: string, b: string) => (a ? `${a} ${b}` : b);

/** The steps of a manual test's script. */
export function parseManualScript(name: string, script: string): ParsedScript {
	const steps: PlanStep[] = [];
	const calls: string[] = [];
	// Where a line without `-` continues: the action or the last check of the last step.
	let continues: 'action' | 'expect' | null = null;
	for (const raw of script.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const step = /^-\s*(\?|@)?\s*(.*)$/.exec(line);
		const last = steps.at(-1);
		if (!step) {
			if (last && continues === 'action') last.action = join(last.action, line);
			else if (last && continues === 'expect')
				last.expect.push(join(last.expect.pop() ?? '', line));
			else steps.push({ action: line, expect: [] });
			continues ??= 'action';
			continue;
		}
		const [, kind, text = ''] = step;
		if (kind === '?') {
			if (last) last.expect.push(text);
			else steps.push({ action: '', expect: [text] });
			continues = 'expect';
		} else if (kind === '@') {
			calls.push(text);
			steps.push({ action: `Run the steps of the called Octane test ${text}`, expect: [] });
			continues = 'action';
		} else {
			steps.push({ action: text, expect: [] });
			continues = 'action';
		}
	}
	return { scenarios: [{ name, steps, examples: [] }], calls };
}

const SCENARIO = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/;
const STEP = /^(Given|When|Then|And|But|\*)\s+(.*)$/;

/**
 * The scenarios of a Gherkin test (English keywords). Background steps come first in each
 * scenario; Then and the And or But after it are checks of the step before, the rest actions.
 */
export function parseGherkinScript(name: string, script: string): ParsedScript {
	const background: PlanStep[] = [];
	const scenarios: PlanScenario[] = [];
	let target: PlanStep[] | null = null;
	let current: PlanScenario | null = null;
	let inExamples = false;
	let inDocString = false;
	let lastKind: 'action' | 'expect' = 'action';
	const append = (text: string) => {
		const last = target?.at(-1);
		if (!last) return;
		if (lastKind === 'expect' && last.expect.length > 0)
			last.expect.push(join(last.expect.pop() ?? '', text));
		else last.action = join(last.action, text);
	};
	for (const raw of script.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('"""') || line.startsWith('```')) {
			inDocString = !inDocString;
			continue;
		}
		if (inDocString) {
			if (line) append(line);
			continue;
		}
		if (!line || line.startsWith('#') || line.startsWith('@')) continue;
		const scenario = SCENARIO.exec(line);
		if (scenario) {
			current = { name: scenario[2] || name, steps: structuredClone(background), examples: [] };
			scenarios.push(current);
			target = current.steps;
			inExamples = false;
			continue;
		}
		if (line.startsWith('Background:')) {
			target = background;
			continue;
		}
		if (/^(Feature|Rule):/.test(line)) {
			target = null;
			continue;
		}
		if (/^(Examples|Scenarios):/.test(line)) {
			inExamples = true;
			continue;
		}
		if (line.startsWith('|')) {
			if (inExamples) current?.examples.push(line);
			else append(line);
			continue;
		}
		const step = STEP.exec(line);
		if (!step || !target) continue;
		const [, keyword = '', text = ''] = step;
		const kind: 'action' | 'expect' =
			keyword === 'Then'
				? 'expect'
				: keyword === 'Given' || keyword === 'When'
					? 'action'
					: lastKind;
		const last = target.at(-1);
		if (kind === 'expect' && last) last.expect.push(`${keyword} ${text}`);
		else if (kind === 'expect') target.push({ action: '', expect: [`${keyword} ${text}`] });
		else target.push({ action: `${keyword} ${text}`, expect: [] });
		lastKind = kind;
	}
	if (scenarios.length === 0 && background.length > 0)
		scenarios.push({ name, steps: background, examples: [] });
	return { scenarios, calls: [] };
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

/** The text of an Octane rich-text field (HTML): paragraphs and list items on lines of their own. */
export function htmlToText(html: string): string {
	return html
		.replaceAll(/<\s*br\s*\/?>/gi, '\n')
		.replaceAll(/<\s*li[^>]*>/gi, '\n- ')
		.replaceAll(/<\/\s*(p|div|h[1-6]|tr|ul|ol)\s*>/gi, '\n')
		.replaceAll(/<[^>]*>/g, '')
		.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, code: string) => {
			const lower = code.toLowerCase();
			if (lower.startsWith('#')) {
				const point = lower.startsWith('#x')
					? Number.parseInt(lower.slice(2), 16)
					: Number(lower.slice(1));
				return point <= 0x10_ffff ? String.fromCodePoint(point) : entity;
			}
			return Object.hasOwn(ENTITIES, lower) ? (ENTITIES[lower] ?? entity) : entity;
		})
		.split('\n')
		.map((l) => l.replaceAll(/[ \t\u00A0]+/g, ' ').trim())
		.join('\n')
		.replaceAll(/\n{3,}/g, '\n\n')
		.trim();
}
