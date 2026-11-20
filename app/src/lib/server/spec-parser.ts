import ts from 'typescript';
import type {
	FlowStep,
	Issue,
	LocatorInfo,
	LocatorKind,
	SpecFile,
	SpecTest,
	Surface
} from '#lib/shared/types.js';

/** helper name → locator kind it wraps, built from sap-tests/helpers (e.g. `button` → ui5). */
export type HelperMap = Record<string, { locator?: LocatorKind; isAction: boolean }>;

const LOCATOR_METHODS: Record<string, LocatorKind> = {
	getByRoleUI5: 'ui5',
	getByRoleSID: 'sid',
	locateSID: 'sid-path',
	getByRole: 'role',
	getByLabel: 'label',
	getByText: 'text',
	getByTestId: 'testid',
	getByPlaceholder: 'placeholder',
	getByTitle: 'text',
	getByAltText: 'text',
	locator: 'css'
};
const ACTIONS = new Set([
	'click',
	'dblclick',
	'fill',
	'press',
	'type',
	'pressSequentially',
	'check',
	'uncheck',
	'selectOption',
	'hover',
	'focus',
	'clear',
	'setInputFiles',
	'tap',
	'dragTo'
]);
const NAVIGATION = new Set(['goto', 'setContent', 'reload', 'goBack', 'goForward']);
const WAITS = new Set([
	'waitForTimeout',
	'waitForURL',
	'waitForLoadState',
	'waitForSelector',
	'waitForResponse'
]);
/** Clicks on these labels change data, so the guide wants an assertion right after them (§5.2). */
const DATA_CHANGING =
	/\b(save|post|submit|confirm|approve|delete|sichern|speichern|buchen|löschen|genehmigen)\b/i;

const SAP_SURFACES: Surface[] = ['fiori', 'webgui'];

export function surfaceFromPath(file: string): Surface | undefined {
	const top = file.split('/')[0];
	if (top === 'fiori' || top === 'webgui' || top === 'ariba') return top;
	if (top === '_demo') return 'demo';
	return undefined;
}

type Ctx = {
	sf: ts.SourceFile;
	consts: Map<string, string>;
	helpers: HelperMap;
	seq: number;
};

function lineOf(ctx: Ctx, pos: number) {
	return ctx.sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Human-readable value of an argument: literals verbatim, constants resolved, env vars as `$NAME`. */
function argText(ctx: Ctx, node: ts.Expression): string {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isNumericLiteral(node)) return node.text;
	if (ts.isNonNullExpression(node)) return argText(ctx, node.expression);
	if (ts.isIdentifier(node)) {
		const v = ctx.consts.get(node.text);
		return v !== undefined ? v : node.text;
	}
	if (
		ts.isPropertyAccessExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.getText(ctx.sf) === 'process.env'
	) {
		return '$' + node.name.text;
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return argText(ctx, node.left) + argText(ctx, node.right);
	}
	return node.getText(ctx.sf);
}

function objectProps(node: ts.Expression | undefined): string[] {
	if (!node || !ts.isObjectLiteralExpression(node)) return [];
	return node.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : '?'));
}

type Segment = { name: string; args: readonly ts.Expression[]; node: ts.CallExpression };

/**
 * Flattens `page.getByRoleUI5('Button', {...}).click()` into
 * root=`page`, segments=[getByRoleUI5(...), click()].
 */
function flatten(expr: ts.Expression): { root: ts.Expression; segments: Segment[] } {
	const segments: Segment[] = [];
	let cur: ts.Expression = expr;
	for (;;) {
		if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
			cur = cur.expression;
		} else if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
			segments.unshift({ name: cur.expression.name.text, args: cur.arguments, node: cur });
			cur = cur.expression.expression;
		} else if (ts.isPropertyAccessExpression(cur)) {
			// `page.keyboard.press` – keep the property as an argument-less segment
			segments.unshift({ name: cur.name.text, args: [], node: undefined as never });
			cur = cur.expression;
		} else {
			break;
		}
	}
	return { root: cur, segments };
}

function classifyCss(ctx: Ctx, arg: ts.Expression | undefined): LocatorKind {
	const text = arg ? argText(ctx, arg) : '';
	return /^(xpath=|\/\/|\.\.\/|\(\/\/)/.test(text) ? 'xpath' : 'css';
}

function describeLocator(
	ctx: Ctx,
	root: ts.Expression,
	segments: Segment[]
): LocatorInfo | undefined {
	let info: LocatorInfo | undefined;
	if (ts.isCallExpression(root) && ts.isIdentifier(root.expression)) {
		const name = root.expression.text;
		const helper = ctx.helpers[name];
		const args = root.arguments.slice(1).map((a) => JSON.stringify(argText(ctx, a)));
		info = {
			kind: helper?.locator ?? 'other',
			display: `${name}(${args.join(', ')})`,
			helper: name
		};
	}
	for (const seg of segments) {
		const kind = LOCATOR_METHODS[seg.name];
		if (kind && seg.node && (!info || seg.name !== 'locator')) {
			const k = seg.name === 'locator' ? classifyCss(ctx, seg.args[0]) : kind;
			info = {
				kind: k,
				display: seg.node
					.getText(ctx.sf)
					.replace(/^page\./, '')
					.replace(/\s+/g, ' ')
			};
			// Strip trailing action from display: `getByLabel('X').fill('1')` → `getByLabel('X')`
			const idx = info.display.lastIndexOf(').');
			if (idx > -1 && ACTIONS.has(info.display.slice(idx + 2).split('(')[0])) {
				info.display = info.display.slice(0, idx + 1);
			}
		} else if (kind && seg.name === 'locator' && info) {
			// chained .locator() on an existing locator: refine kind only if it is css/xpath
			info = {
				...info,
				display: info.display + `.locator(${seg.args.map((a) => a.getText(ctx.sf)).join(', ')})`
			};
		}
	}
	return info;
}

function makeStep(
	ctx: Ctx,
	stmt: ts.Node,
	partial: Omit<FlowStep, 'id' | 'line' | 'endLine' | 'code' | 'issues'>
): FlowStep {
	return {
		id: `s${++ctx.seq}`,
		line: lineOf(ctx, stmt.getStart(ctx.sf)),
		endLine: lineOf(ctx, stmt.getEnd()),
		code: stmt.getText(ctx.sf).replace(/\s+/g, ' ').trim(),
		issues: [],
		...partial
	};
}

/** Turns one awaited expression into a flow step, or undefined if it is not test-relevant. */
function analyzeAwait(ctx: Ctx, stmt: ts.Node, expr: ts.Expression): FlowStep | undefined {
	const { root, segments } = flatten(expr);
	const last = segments[segments.length - 1];

	// expect(locator).toBeVisible() / expect.soft(...)
	if (
		ts.isCallExpression(root) &&
		ts.isIdentifier(root.expression) &&
		root.expression.text === 'expect'
	) {
		const target = root.arguments[0];
		let locator: LocatorInfo | undefined;
		if (target) {
			const inner = flatten(target);
			locator = describeLocator(ctx, inner.root, inner.segments) ?? {
				kind: 'other',
				display: target.getText(ctx.sf)
			};
		}
		const matchers = segments.filter((s) => s.name !== 'not');
		const matcher = matchers[matchers.length - 1];
		const negated = segments.some((s) => s.name === 'not');
		return makeStep(ctx, stmt, {
			kind: 'assert',
			action: (negated ? 'not.' : '') + (matcher?.name ?? 'expect'),
			locator,
			value:
				matcher?.args[0] && !ts.isObjectLiteralExpression(matcher.args[0])
					? argText(ctx, matcher.args[0])
					: undefined
		});
	}

	// test.step('title', async () => { ... }) is handled by the caller (group)

	// Bare helper call: runTransaction(page, 'VA03')
	if (segments.length === 0 && ts.isCallExpression(root) && ts.isIdentifier(root.expression)) {
		const name = root.expression.text;
		const args = root.arguments.slice(1).map((a) => argText(ctx, a));
		return makeStep(ctx, stmt, {
			kind: 'helper',
			action: name,
			value: args.join(', ') || undefined,
			locator: ctx.helpers[name]?.locator
				? { kind: ctx.helpers[name].locator!, display: name, helper: name }
				: undefined
		});
	}

	if (!last) return undefined;
	const lastArgs = last.args.map((a) => argText(ctx, a));

	if (last.name === 'SAPLogin') {
		return makeStep(ctx, stmt, { kind: 'login', action: 'SAPLogin', value: lastArgs[0] });
	}
	if (NAVIGATION.has(last.name) && segments.length === 1) {
		const value = last.name === 'setContent' ? 'inline HTML' : lastArgs[0];
		return makeStep(ctx, stmt, { kind: 'navigate', action: last.name, value });
	}
	if (WAITS.has(last.name) && segments.length === 1) {
		return makeStep(ctx, stmt, { kind: 'wait', action: last.name, value: lastArgs[0] });
	}
	if (segments.length === 2 && segments[0].name === 'keyboard') {
		return makeStep(ctx, stmt, {
			kind: 'action',
			action: 'keyboard.' + last.name,
			value: lastArgs[0]
		});
	}
	if (ACTIONS.has(last.name)) {
		const locator = describeLocator(ctx, root, segments.slice(0, -1));
		return makeStep(ctx, stmt, {
			kind: 'action',
			action: last.name,
			locator,
			value: ['fill', 'press', 'type', 'pressSequentially', 'selectOption'].includes(last.name)
				? lastArgs[0]
				: undefined
		});
	}
	return makeStep(ctx, stmt, { kind: 'other', action: last.name });
}

function collectSteps(ctx: Ctx, body: ts.ConciseBody | undefined, out: FlowStep[]) {
	if (!body || !ts.isBlock(body)) return;
	for (const stmt of body.statements) {
		let expr: ts.Expression | undefined;
		if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
		else if (ts.isVariableStatement(stmt)) expr = stmt.declarationList.declarations[0]?.initializer;
		else if (ts.isIfStatement(stmt) || ts.isForOfStatement(stmt) || ts.isTryStatement(stmt)) {
			// Control flow inside a test is rare in recordings; show it as one opaque node.
			out.push(
				makeStep(ctx, stmt, { kind: 'other', action: stmt.getText(ctx.sf).split(/[\s(]/)[0] })
			);
			continue;
		}
		if (!expr || !ts.isAwaitExpression(expr)) continue;
		const inner = expr.expression;
		// await test.step('title', async () => { ... })
		if (
			ts.isCallExpression(inner) &&
			ts.isPropertyAccessExpression(inner.expression) &&
			inner.expression.getText(ctx.sf) === 'test.step'
		) {
			const title = inner.arguments[0] ? argText(ctx, inner.arguments[0]) : 'step';
			out.push(makeStep(ctx, stmt, { kind: 'group', action: 'test.step', value: title }));
			const fn = inner.arguments[1];
			if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
				collectSteps(ctx, fn.body, out);
			continue;
		}
		const step = analyzeAwait(ctx, stmt, inner);
		if (step) out.push(step);
	}
}

function testCallKind(
	ctx: Ctx,
	call: ts.CallExpression
): 'test' | 'describe' | 'beforeEach' | undefined {
	const callee = call.expression.getText(ctx.sf);
	if (/^test(\.(only|skip|fixme|fail|slow))?$/.test(callee)) {
		return call.arguments.length >= 2 && ts.isStringLiteralLike(call.arguments[0])
			? 'test'
			: undefined;
	}
	if (/^test\.describe(\.(only|skip|serial|parallel|fixme))*$/.test(callee)) return 'describe';
	if (callee === 'test.beforeEach') return 'beforeEach';
	return undefined;
}

function fnArg(call: ts.CallExpression) {
	const fn = call.arguments[call.arguments.length - 1];
	return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
}

function detectSurface(file: string, steps: FlowStep[]): Surface {
	const byPath = surfaceFromPath(file);
	if (byPath) return byPath;
	if (steps.some((s) => s.locator?.kind === 'ui5')) return 'fiori';
	if (steps.some((s) => s.locator?.kind === 'sid' || s.locator?.kind === 'sid-path'))
		return 'webgui';
	return 'other';
}

/** Guide §5.2 / §9 rules, applied per test. */
export function checkRules(test: Pick<SpecTest, 'surface' | 'steps'>): Issue[] {
	const issues: Issue[] = [];
	const sap = SAP_SURFACES.includes(test.surface);
	const add = (step: FlowStep, rule: string, severity: Issue['severity'], message: string) => {
		const issue = { rule, severity, message, line: step.line };
		step.issues.push(issue);
		issues.push(issue);
	};
	const actionable = test.steps.filter((s) => !s.hook);
	actionable.forEach((step, i) => {
		const kind = step.locator?.kind;
		if (step.action === 'waitForTimeout') {
			add(
				step,
				'no-fixed-wait',
				'error',
				'Fixed wait. Wait for a control or status message instead.'
			);
		}
		if (sap && (kind === 'css' || kind === 'xpath')) {
			add(
				step,
				'no-css-xpath',
				'error',
				`${kind.toUpperCase()} selector on an SAP screen. Use getByRoleUI5 / getByRoleSID / locateSID.`
			);
		}
		if (kind === 'ui5' && /getByRoleUI5\(/.test(step.code)) {
			const m = step.code.match(/getByRoleUI5\([^,]+,\s*\{([^}]*)\}/);
			if (m && m[1].split(',').filter((p) => p.includes(':')).length > 1) {
				add(
					step,
					'ui5-single-property',
					'error',
					'getByRoleUI5 supports only one property per call.'
				);
			}
		}
		if (/\.nth\(/.test(step.code)) {
			add(
				step,
				'avoid-nth',
				'info',
				'.nth() only when no property identifies the control uniquely.'
			);
		}
		if (sap && step.kind === 'action' && (kind === 'role' || kind === 'label' || kind === 'text')) {
			add(
				step,
				'prefer-sap-locator',
				'info',
				'Standard locator on an SAP screen. Prefer the SAP locator or a helper.'
			);
		}
		if (
			step.action === 'fill' &&
			/pass|kennwort/i.test(step.locator?.display ?? '') &&
			step.value &&
			!step.value.startsWith('$')
		) {
			add(step, 'no-literal-secret', 'error', 'Password typed as a literal. Read it from .env.');
		}
		if (
			step.kind === 'action' &&
			step.action === 'click' &&
			DATA_CHANGING.test(step.locator?.display ?? '')
		) {
			const next = actionable[i + 1];
			if (!next || next.kind !== 'assert') {
				add(
					step,
					'assert-after-change',
					'warning',
					'Data-changing step without an assertion right after it.'
				);
			}
		}
	});
	if (actionable.length > 0 && !actionable.some((s) => s.kind === 'assert')) {
		const last = actionable[actionable.length - 1];
		add(last, 'has-assertion', 'warning', 'Test has no assertion.');
	}
	return issues;
}

function collectConsts(sf: ts.SourceFile): Map<string, string> {
	const consts = new Map<string, string>();
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const d of stmt.declarationList.declarations) {
			if (
				ts.isIdentifier(d.name) &&
				d.initializer &&
				(ts.isStringLiteralLike(d.initializer) || ts.isNumericLiteral(d.initializer))
			) {
				consts.set(d.name.text, d.initializer.text);
			}
		}
	}
	return consts;
}

export function parseSpec(file: string, source: string, helpers: HelperMap = {}): SpecFile {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const ctx: Ctx = { sf, consts: collectConsts(sf), helpers, seq: 0 };
	const tests: SpecTest[] = [];

	const walk = (statements: readonly ts.Statement[], titles: string[], hooks: FlowStep[]) => {
		const scopeHooks = [...hooks];
		// beforeEach applies to the whole scope regardless of position, so collect hooks first.
		for (const stmt of statements) {
			if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
			if (testCallKind(ctx, stmt.expression) === 'beforeEach') {
				const steps: FlowStep[] = [];
				collectSteps(ctx, fnArg(stmt.expression)?.body, steps);
				scopeHooks.push(...steps.map((s) => ({ ...s, hook: true })));
			}
		}
		for (const stmt of statements) {
			if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
			const call = stmt.expression;
			const kind = testCallKind(ctx, call);
			if (kind === 'describe') {
				const title =
					call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])
						? call.arguments[0].text
						: '';
				const fn = fnArg(call);
				if (fn && ts.isBlock(fn.body))
					walk(fn.body.statements, title ? [...titles, title] : titles, scopeHooks);
			} else if (kind === 'test') {
				const title = (call.arguments[0] as ts.StringLiteral).text;
				const steps: FlowStep[] = scopeHooks.map((h) => ({ ...h, issues: [] }));
				collectSteps(ctx, fnArg(call)?.body, steps);
				const titlePath = [...titles, title];
				const surface = detectSurface(file, steps);
				const test: SpecTest = {
					key: `${file}::${titlePath.join(' › ')}`,
					file,
					title,
					titlePath,
					line: lineOf(ctx, stmt.getStart(sf)),
					surface,
					steps,
					issues: []
				};
				test.issues = checkRules(test);
				tests.push(test);
			}
		}
	};
	walk(sf.statements, [], []);

	const fileIssues: Issue[] = [];
	const marker = source.match(/KI-generiert,\s*geprüft von:\s*(.*)/);
	if (marker && (!marker[1].trim() || /<name>/i.test(marker[1]))) {
		const line = source.slice(0, marker.index).split('\n').length;
		fileIssues.push({
			rule: 'ai-review',
			severity: 'warning',
			message: 'AI-generated test without a named reviewer.',
			line
		});
	}
	const surface = surfaceFromPath(file) ?? tests[0]?.surface ?? 'other';
	return { file, surface, tests, issues: fileIssues };
}

/** Reads helpers/*.ts and records, per exported function, which locator it wraps. */
export function parseHelpers(files: { file: string; source: string }[]): HelperMap {
	const map: HelperMap = {};
	for (const { file, source } of files) {
		const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const record = (name: string, body: ts.Node) => {
			let locator: LocatorKind | undefined;
			let isAction = false;
			const visit = (n: ts.Node) => {
				if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
					const m = n.expression.name.text;
					if (!locator && LOCATOR_METHODS[m])
						locator = m === 'locator' ? 'css' : LOCATOR_METHODS[m];
					if (ACTIONS.has(m)) isAction = true;
				}
				ts.forEachChild(n, visit);
			};
			visit(body);
			map[name] = { locator, isAction };
		};
		for (const stmt of sf.statements) {
			if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body)
				record(stmt.name.text, stmt.body);
			if (ts.isVariableStatement(stmt)) {
				for (const d of stmt.declarationList.declarations) {
					if (ts.isIdentifier(d.name) && d.initializer) record(d.name.text, d.initializer);
				}
			}
		}
	}
	return map;
}
