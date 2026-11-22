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
	locateUI5Control: 'ui5',
	locateUI5: 'ui5-xpath',
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
/**
 * A record's own entry for a name from the parsed source. Plain lookups would also find what every object
 * inherits: `.toString()` in a spec would come back as Object.prototype.toString, a function the page then
 * cannot send to the browser.
 */
function own<T>(record: Record<string, T>, name: string): T | undefined {
	return Object.hasOwn(record, name) ? record[name] : undefined;
}

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
	'waitForResponse',
	'waitForUI5'
]);
/** The plugin's reads of UI5 model state; their first argument is the control to read from. */
const MODEL_READS = new Set(['ui5BoundData', 'ui5ModelProperty', 'ui5HasPendingChanges']);
/** What a request built with a generated OData client does, by the builder method that says so. */
const ODATA_OPERATIONS = ['batch', 'getAll', 'getByKey', 'create', 'update', 'delete'] as const;
/** Clicks on these labels change data, so the guide wants an assertion right after them (§5.2). */
const DATA_CHANGING =
	/\b(save|post|submit|confirm|approve|delete|sichern|speichern|buchen|löschen|genehmigen)\b/i;

const SAP_SURFACES = new Set<Surface>(['fiori', 'webgui']);

function surfaceFromPath(file: string): Surface | undefined {
	const top = file.split('/')[0];
	if (top === 'fiori' || top === 'webgui' || top === 'ariba' || top === 'api') return top;
	if (top === '_demo') return 'demo';
	// The plugin's own tests mix UI5 and WebGUI stand-ins; they are no business flow of a surface.
	if (top === '_plugin') return 'other';
	return undefined;
}

/**
 * What the rule check needs to know about a step beyond its display fields, read from the syntax
 * tree instead of the code text. Kept out of FlowStep so it never reaches the client.
 */
type Facts = {
	/** A password given as a literal (or a literal constant) instead of an env value. */
	literalSecret: boolean;
	/** A password typed with fill, which writes it into the step titles (report, run data). */
	secretFill: boolean;
	nth: boolean;
	/** Steps inside a control-flow statement, which the flow shows as one opaque node. */
	inner: FlowStep[];
};

type Ctx = {
	sf: ts.SourceFile;
	consts: Map<string, string>;
	/** Top-level `const NAMES = ['a', 'b']`, for tests generated in a loop over it. */
	arrays: Map<string, string[]>;
	helpers: HelperMap;
	seq: number;
	/** Keyed by step id. */
	facts: Map<string, Facts>;
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
		return ctx.consts.get(node.text) ?? node.text;
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

/** True when the value is written into the spec: a literal, or a constant holding one. */
function isLiteral(ctx: Ctx, node: ts.Expression | undefined): boolean {
	if (!node) return false;
	if (
		ts.isNonNullExpression(node) ||
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node)
	) {
		return isLiteral(ctx, node.expression);
	}
	if (ts.isStringLiteralLike(node)) return node.text !== '';
	if (ts.isIdentifier(node)) return Boolean(ctx.consts.get(node.text));
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return isLiteral(ctx, node.left) && isLiteral(ctx, node.right);
	}
	return false;
}

/** Whether a statement calls `.nth()` anywhere in it. */
function callsNth(node: ts.Node): boolean {
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'nth'
	) {
		return true;
	}
	return ts.forEachChild(node, callsNth) ?? false;
}

/** `node` is absent for property-access segments such as `keyboard` in `page.keyboard.press()`. */
type Segment = { name: string; args: readonly ts.Expression[]; node?: ts.CallExpression };

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
			segments.unshift({ name: cur.name.text, args: [] });
			cur = cur.expression;
		} else {
			break;
		}
	}
	return { root: cur, segments };
}

/** sap-plugin functions that build the selector string for `locator()`, as recorded inside iframes. */
const SELECTOR_BUILDERS: Record<string, LocatorKind> = {
	ui5ControlSelector: 'ui5',
	ui5ChartPointSelector: 'ui5',
	locateSIDSelector: 'sid-path'
};

function classifyCss(ctx: Ctx, arg: ts.Expression | undefined): LocatorKind {
	if (arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
		const built = own(SELECTOR_BUILDERS, arg.expression.text);
		if (built) return built;
	}
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
		const helper = own(ctx.helpers, name);
		const args = root.arguments.slice(1).map((a) => JSON.stringify(argText(ctx, a)));
		info = {
			kind: helper?.locator ?? 'other',
			display: `${name}(${args.join(', ')})`,
			helper: name
		};
	}
	for (const seg of segments) {
		const kind = own(LOCATOR_METHODS, seg.name);
		if (kind && seg.node && (!info || seg.name !== 'locator')) {
			const k = seg.name === 'locator' ? classifyCss(ctx, seg.args[0]) : kind;
			info = {
				kind: k,
				display: seg.node
					.getText(ctx.sf)
					.replace(/^page\./, '')
					.replaceAll(/\s+/g, ' ')
			};
			// Strip trailing action from display: `getByLabel('X').fill('1')` → `getByLabel('X')`
			const idx = info.display.lastIndexOf(').');
			if (idx > -1 && ACTIONS.has(info.display.slice(idx + 2).split('(')[0] ?? '')) {
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
	partial: Omit<FlowStep, 'id' | 'line' | 'endLine' | 'code' | 'issues'>,
	facts: { literalSecret?: boolean; secretFill?: boolean; inner?: FlowStep[] } = {}
): FlowStep {
	const id = `s${++ctx.seq}`;
	// A group or control-flow statement contains other steps, which are scanned on their own.
	const container = partial.kind === 'group' || facts.inner !== undefined;
	ctx.facts.set(id, {
		literalSecret: facts.literalSecret ?? false,
		secretFill: facts.secretFill ?? false,
		inner: facts.inner ?? [],
		nth: !container && callsNth(stmt)
	});
	return {
		id,
		line: lineOf(ctx, stmt.getStart(ctx.sf)),
		endLine: lineOf(ctx, stmt.getEnd()),
		code: stmt.getText(ctx.sf).replaceAll(/\s+/g, ' ').trim(),
		issues: [],
		...partial
	};
}

/**
 * Recognises an assertion chain: `expect(x).…`, `expect.soft(x).…` and `expect.poll(fn).…`.
 * Returns what is asserted on and the matcher segments after it.
 */
function expectChain(
	root: ts.Expression,
	segments: Segment[]
): { target: ts.Expression | undefined; matchers: Segment[] } | undefined {
	if (ts.isCallExpression(root) && ts.isIdentifier(root.expression)) {
		return root.expression.text === 'expect'
			? { target: root.arguments[0], matchers: segments }
			: undefined;
	}
	const [first, ...rest] = segments;
	if (
		ts.isIdentifier(root) &&
		root.text === 'expect' &&
		first?.node &&
		(first.name === 'soft' || first.name === 'poll')
	) {
		return { target: first.args[0], matchers: rest };
	}
	return undefined;
}

/** What an expression points at: a locator if it is one, otherwise its source text. */
function subjectOf(ctx: Ctx, node: ts.Expression): LocatorInfo {
	const { root, segments } = flatten(node);
	return describeLocator(ctx, root, segments) ?? { kind: 'other', display: node.getText(ctx.sf) };
}

/** Turns one awaited expression into a flow step, or undefined if it is not test-relevant. */
function analyzeAwait(ctx: Ctx, stmt: ts.Node, expr: ts.Expression): FlowStep | undefined {
	const { root, segments } = flatten(expr);
	const last = segments.at(-1);

	// expect(locator).toBeVisible() / expect.soft(...) / expect.poll(...)
	const assertion = expectChain(root, segments);
	if (assertion) {
		const { target } = assertion;
		const locator = target ? subjectOf(ctx, target) : undefined;
		const matcher = assertion.matchers.findLast((s) => s.name !== 'not');
		const firstArg = matcher?.args[0];
		const negated = assertion.matchers.some((s) => s.name === 'not');
		return makeStep(ctx, stmt, {
			kind: 'assert',
			action: (negated ? 'not.' : '') + (matcher?.name ?? 'expect'),
			locator,
			value:
				firstArg && !ts.isObjectLiteralExpression(firstArg) ? argText(ctx, firstArg) : undefined
		});
	}

	// test.step groups are handled by the caller (collectSteps).

	// fillSecret(field, process.env.SAP_PASSWORD!) from sap-plugin: types a password unrecorded.
	if (
		segments.length === 0 &&
		ts.isCallExpression(root) &&
		ts.isIdentifier(root.expression) &&
		root.expression.text === 'fillSecret'
	) {
		const [field, value] = root.arguments;
		return makeStep(
			ctx,
			stmt,
			{
				kind: 'action',
				action: 'fillSecret',
				locator: field ? subjectOf(ctx, field) : undefined,
				value: value ? argText(ctx, value) : undefined
			},
			{ literalSecret: isLiteral(ctx, value) }
		);
	}

	// Bare helper call: runTransaction(page, 'VA03')
	if (segments.length === 0 && ts.isCallExpression(root) && ts.isIdentifier(root.expression)) {
		const name = root.expression.text;
		const args = root.arguments.slice(1).map((a) => argText(ctx, a));
		const helperLocator = own(ctx.helpers, name)?.locator;
		return makeStep(ctx, stmt, {
			kind: 'helper',
			action: name,
			value: args.join(', ') || undefined,
			locator: helperLocator ? { kind: helperLocator, display: name, helper: name } : undefined
		});
	}

	if (!last) return undefined;
	const lastArgs = last.args.map((a) => argText(ctx, a));

	if (last.name === 'SAPLogin') {
		// SAPLogin(username, password, url)
		return makeStep(
			ctx,
			stmt,
			{ kind: 'login', action: 'SAPLogin', value: lastArgs[0] },
			{ literalSecret: isLiteral(ctx, last.args[1]) }
		);
	}
	if (NAVIGATION.has(last.name) && segments.length === 1) {
		const value = last.name === 'setContent' ? 'inline HTML' : lastArgs[0];
		return makeStep(ctx, stmt, { kind: 'navigate', action: last.name, value });
	}
	if (WAITS.has(last.name) && segments.length === 1) {
		return makeStep(ctx, stmt, { kind: 'wait', action: last.name, value: lastArgs[0] });
	}
	if (segments.length === 2 && segments[0]?.name === 'keyboard') {
		return makeStep(ctx, stmt, {
			kind: 'action',
			action: 'keyboard.' + last.name,
			value: lastArgs[0]
		});
	}
	if (ACTIONS.has(last.name)) {
		const locator = describeLocator(ctx, root, segments.slice(0, -1));
		const password =
			last.name === 'fill' &&
			(/pass|kennwort/i.test(locator?.display ?? '') ||
				/^\$\w*(PASS|KENNWORT)/i.test(lastArgs[0] ?? ''));
		const literalSecret = password && isLiteral(ctx, last.args[0]);
		return makeStep(
			ctx,
			stmt,
			{
				kind: 'action',
				action: last.name,
				locator,
				value: ['fill', 'press', 'type', 'pressSequentially', 'selectOption'].includes(last.name)
					? lastArgs[0]
					: undefined
			},
			{ literalSecret, secretFill: password && !literalSecret }
		);
	}
	if (MODEL_READS.has(last.name) && segments.length === 1) {
		const [control] = last.args;
		return makeStep(ctx, stmt, {
			kind: 'other',
			action: last.name,
			locator: control ? subjectOf(ctx, control) : undefined
		});
	}
	// products.requestBuilder().getAll().top(5).execute(sapApi) / gwsample.batch(…).execute(sapApi)
	if (last.name === 'execute') {
		const operation = ODATA_OPERATIONS.find((name) => segments.some((s) => s.name === name));
		if (operation || segments.some((s) => s.name === 'requestBuilder')) {
			return makeStep(ctx, stmt, {
				kind: 'other',
				action: `odata.${operation ?? 'request'}`,
				// The entity API the request goes to, as the spec names it: `products`.
				value: operation !== 'batch' && ts.isIdentifier(root) ? root.text : undefined
			});
		}
	}
	return makeStep(ctx, stmt, { kind: 'other', action: last.name });
}

function isControlFlow(stmt: ts.Statement): boolean {
	return (
		ts.isIfStatement(stmt) ||
		ts.isIterationStatement(stmt, false) ||
		ts.isTryStatement(stmt) ||
		ts.isSwitchStatement(stmt)
	);
}

/** The statements a control-flow statement runs, from all of its branches, in source order. */
function branchStatements(stmt: ts.Statement): ts.Statement[] {
	const found: ts.Statement[] = [];
	const visit = (n: ts.Node) => {
		if (ts.isFunctionLike(n)) return;
		if (ts.isBlock(n)) found.push(...n.statements);
		else if (ts.isStatement(n)) found.push(n);
		else ts.forEachChild(n, visit);
	};
	ts.forEachChild(stmt, visit);
	return found;
}

function collectSteps(ctx: Ctx, body: ts.ConciseBody | undefined, out: FlowStep[]) {
	if (!body || !ts.isBlock(body)) return;
	collectStatements(ctx, body.statements, out);
}

function collectStatements(ctx: Ctx, statements: readonly ts.Statement[], out: FlowStep[]) {
	for (const stmt of statements) {
		let expr: ts.Expression | undefined;
		if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
		else if (ts.isVariableStatement(stmt)) expr = stmt.declarationList.declarations[0]?.initializer;
		else if (isControlFlow(stmt)) {
			// Control flow inside a test is rare in recordings; show it as one opaque node. Its steps
			// are still collected, so the rule check sees what the node hides.
			const inner: FlowStep[] = [];
			collectStatements(ctx, branchStatements(stmt), inner);
			out.push(
				makeStep(
					ctx,
					stmt,
					{ kind: 'other', action: stmt.getText(ctx.sf).split(/[\s(]/)[0] ?? '' },
					{ inner }
				)
			);
			continue;
		}
		if (!expr) continue;
		const inner = ts.isAwaitExpression(expr) ? expr.expression : expr;
		if (!ts.isAwaitExpression(expr)) {
			// Not awaited: only value assertions such as `expect(await page.title()).toBe('x')` are steps.
			const chain = flatten(inner);
			if (!expectChain(chain.root, chain.segments)) continue;
		}
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
		// `test.skip(condition, 'reason')` and `test.skip(() => condition)` are not tests: a test has
		// a title first and a function last.
		const [title] = call.arguments;
		return title && call.arguments.length > 1 && !ts.isFunctionLike(title) && fnArg(call)
			? 'test'
			: undefined;
	}
	if (/^test\.describe(\.(only|skip|serial|parallel|fixme))*$/.test(callee)) return 'describe';
	if (callee === 'test.beforeEach') return 'beforeEach';
	return undefined;
}

function fnArg(call: ts.CallExpression) {
	const fn = call.arguments.at(-1);
	return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
}

function detectSurface(file: string, steps: FlowStep[]): Surface {
	const byPath = surfaceFromPath(file);
	if (byPath) return byPath;
	if (steps.some((s) => s.locator?.kind === 'ui5' || s.locator?.kind === 'ui5-xpath'))
		return 'fiori';
	if (steps.some((s) => s.locator?.kind === 'sid' || s.locator?.kind === 'sid-path'))
		return 'webgui';
	if (steps.some((s) => s.action.startsWith('odata.'))) return 'api';
	return 'other';
}

/** Guide §5.2 / §9 rules, applied per test. */
function checkRules(ctx: Ctx, test: Pick<SpecTest, 'surface' | 'steps'>): Issue[] {
	const issues: Issue[] = [];
	const sap = SAP_SURFACES.has(test.surface);
	// An object, so TypeScript does not narrow it to `false` across the closure below.
	const seen = { assert: false };

	/**
	 * `shown` is the flow node that carries the findings: the step itself, or the control-flow node
	 * it sits in. `after` is the step that follows the enclosing node, for the last step of a branch.
	 */
	const check = (steps: FlowStep[], shown?: FlowStep, after?: FlowStep) => {
		steps.forEach((step, i) => {
			const node = shown ?? step;
			const next = steps[i + 1] ?? after;
			const facts = ctx.facts.get(step.id);
			const add = (rule: string, severity: Issue['severity'], message: string) => {
				const issue = { rule, severity, message, line: step.line };
				node.issues.push(issue);
				issues.push(issue);
			};
			const kind = step.locator?.kind;
			if (step.kind === 'assert') seen.assert = true;
			if (step.action === 'waitForTimeout') {
				add('no-fixed-wait', 'error', 'Fixed wait. Wait for a control or status message instead.');
			}
			if (sap && (kind === 'css' || kind === 'xpath')) {
				add(
					'no-css-xpath',
					'error',
					`${kind.toUpperCase()} selector on an SAP screen. Use getByRoleUI5 / getByRoleSID / locateSID.`
				);
			}
			if (kind === 'ui5-xpath') {
				add(
					'prefer-role-ui5',
					'info',
					'Path through the UI5 control tree. Prefer getByRoleUI5 where a property identifies the control.'
				);
			}
			if (facts?.nth) {
				add('avoid-nth', 'info', '.nth() only when no property identifies the control uniquely.');
			}
			if (
				sap &&
				step.kind === 'action' &&
				(kind === 'role' || kind === 'label' || kind === 'text')
			) {
				add(
					'prefer-sap-locator',
					'info',
					'Standard locator on an SAP screen. Prefer the SAP locator or a helper.'
				);
			}
			if (facts?.literalSecret) {
				add('no-literal-secret', 'error', 'Password typed as a literal. Read it from .env.');
			}
			if (facts?.secretFill) {
				add(
					'no-secret-fill',
					'warning',
					'fill writes the password into the report and the step list. Use fillSecret from sap-plugin.'
				);
			}
			if (
				step.kind === 'action' &&
				step.action === 'click' &&
				DATA_CHANGING.test(step.locator?.display ?? '') &&
				next?.kind !== 'assert'
			) {
				add(
					'assert-after-change',
					'warning',
					'Data-changing step without an assertion right after it.'
				);
			}
			if (facts?.inner.length) check(facts.inner, node, next);
		});
	};

	const actionable = test.steps.filter((s) => !s.hook);
	check(actionable);
	const last = actionable.at(-1);
	if (last && !seen.assert) {
		const issue: Issue = {
			rule: 'has-assertion',
			severity: 'warning',
			message: 'Test has no assertion.',
			line: last.line
		};
		last.issues.push(issue);
		issues.push(issue);
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

function unwrap(node: ts.Expression): ts.Expression {
	return ts.isAsExpression(node) ||
		ts.isParenthesizedExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isSatisfiesExpression(node)
		? unwrap(node.expression)
		: node;
}

/** The values of `['a', 'b']`, or undefined when an element is not a plain literal. */
function literalElements(node: ts.Expression): string[] | undefined {
	const array = unwrap(node);
	if (!ts.isArrayLiteralExpression(array)) return undefined;
	const values: string[] = [];
	for (const el of array.elements) {
		if (!ts.isStringLiteralLike(el) && !ts.isNumericLiteral(el)) return undefined;
		values.push(el.text);
	}
	return values;
}

function collectArrays(sf: ts.SourceFile): Map<string, string[]> {
	const arrays = new Map<string, string[]>();
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const d of stmt.declarationList.declarations) {
			const values = d.initializer && literalElements(d.initializer);
			if (ts.isIdentifier(d.name) && values) arrays.set(d.name.text, values);
		}
	}
	return arrays;
}

/**
 * A test or describe title. Constants and resolved loop variables are filled in; anything else
 * stays as `${source}` and makes the title dynamic (only known when the test runs).
 */
function titleText(ctx: Ctx, node: ts.Expression): { text: string; dynamic: boolean } {
	const inner = unwrap(node);
	if (ts.isStringLiteralLike(inner) || ts.isNumericLiteral(inner)) {
		return { text: inner.text, dynamic: false };
	}
	if (ts.isIdentifier(inner)) {
		const value = ctx.consts.get(inner.text);
		if (value !== undefined) return { text: value, dynamic: false };
	}
	if (ts.isTemplateExpression(inner)) {
		let text = inner.head.text;
		let dynamic = false;
		for (const span of inner.templateSpans) {
			const part = titleText(ctx, span.expression);
			text += part.text + span.literal.text;
			dynamic ||= part.dynamic;
		}
		return { text, dynamic };
	}
	if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = titleText(ctx, inner.left);
		const right = titleText(ctx, inner.right);
		return { text: left.text + right.text, dynamic: left.dynamic || right.dynamic };
	}
	return { text: '${' + inner.getText(ctx.sf) + '}', dynamic: true };
}

/** A loop that may declare tests: its body, and the loop variable with its values when known. */
type Loop = { body: readonly ts.Statement[]; name?: string; values?: string[] };

function bodyStatements(body: ts.Node): readonly ts.Statement[] {
	if (ts.isBlock(body)) return body.statements;
	if (ts.isStatement(body)) return [body];
	// `(n) => test(...)`: only `.expression` of this statement is read, so it needs no position.
	return ts.isExpression(body) ? [ts.factory.createExpressionStatement(body)] : [];
}

function loopOf(ctx: Ctx, stmt: ts.Statement): Loop | undefined {
	const valuesOf = (list: ts.Expression) => {
		const node = unwrap(list);
		return ts.isIdentifier(node) ? ctx.arrays.get(node.text) : literalElements(node);
	};
	if (ts.isForOfStatement(stmt)) {
		const declared =
			ts.isVariableDeclarationList(stmt.initializer) && stmt.initializer.declarations[0]?.name;
		const name = declared && ts.isIdentifier(declared) ? declared.text : undefined;
		return { body: bodyStatements(stmt.statement), name, values: valuesOf(stmt.expression) };
	}
	if (ts.isIterationStatement(stmt, false)) return { body: bodyStatements(stmt.statement) };
	// ['a', 'b'].forEach((n) => { test(...) })
	if (
		ts.isExpressionStatement(stmt) &&
		ts.isCallExpression(stmt.expression) &&
		ts.isPropertyAccessExpression(stmt.expression.expression) &&
		stmt.expression.expression.name.text === 'forEach'
	) {
		const fn = stmt.expression.arguments[0];
		if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined;
		const param = fn.parameters[0]?.name;
		return {
			body: bodyStatements(fn.body),
			name: param && ts.isIdentifier(param) ? param.text : undefined,
			values: valuesOf(stmt.expression.expression.expression)
		};
	}
	return undefined;
}

export function parseSpec(file: string, source: string, helpers: HelperMap = {}): SpecFile {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const ctx: Ctx = {
		sf,
		consts: collectConsts(sf),
		arrays: collectArrays(sf),
		helpers,
		seq: 0,
		facts: new Map()
	};
	const tests: SpecTest[] = [];

	/** `dynamic`: an enclosing describe title is only known at run time. */
	const walk = (
		statements: readonly ts.Statement[],
		titles: string[],
		hooks: FlowStep[],
		dynamic: boolean
	) => {
		const scopeHooks = [...hooks];
		// beforeEach applies to the whole scope regardless of position, so collect hooks first.
		for (const stmt of statements) {
			if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
			if (testCallKind(ctx, stmt.expression) === 'beforeEach') {
				const steps: FlowStep[] = [];
				collectSteps(ctx, fnArg(stmt.expression)?.body, steps);
				// Copies on purpose: every test gets its own step objects (checkRules mutates issues).
				// oxlint-disable-next-line oxc/no-map-spread
				scopeHooks.push(...steps.map((s) => ({ ...s, hook: true })));
			}
		}
		for (const stmt of statements) {
			// Tests generated in a loop: one set per value when the values are literals in this file,
			// otherwise one entry with a dynamic title.
			const loop = loopOf(ctx, stmt);
			if (loop) {
				const { name, values } = loop;
				if (name && values) {
					const outer = ctx.consts.get(name);
					for (const value of values) {
						ctx.consts.set(name, value);
						walk(loop.body, titles, scopeHooks, dynamic);
					}
					if (outer === undefined) ctx.consts.delete(name);
					else ctx.consts.set(name, outer);
				} else {
					// The loop variable hides a constant of the same name.
					const outer = name === undefined ? undefined : ctx.consts.get(name);
					if (name !== undefined) ctx.consts.delete(name);
					walk(loop.body, titles, scopeHooks, dynamic);
					if (name !== undefined && outer !== undefined) ctx.consts.set(name, outer);
				}
				continue;
			}
			if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
			const call = stmt.expression;
			const kind = testCallKind(ctx, call);
			const first = call.arguments[0];
			if (kind === 'describe') {
				const title =
					first && !ts.isFunctionLike(first) && !ts.isObjectLiteralExpression(first)
						? titleText(ctx, first)
						: { text: '', dynamic: false };
				const fn = fnArg(call);
				if (fn && ts.isBlock(fn.body))
					walk(
						fn.body.statements,
						title.text ? [...titles, title.text] : titles,
						scopeHooks,
						dynamic || title.dynamic
					);
			} else if (kind === 'test' && first) {
				const title = titleText(ctx, first);
				// oxlint-disable-next-line oxc/no-map-spread -- per-test copies, see scopeHooks above
				const steps: FlowStep[] = scopeHooks.map((h) => ({ ...h, issues: [] }));
				collectSteps(ctx, fnArg(call)?.body, steps);
				const titlePath = [...titles, title.text];
				const surface = detectSurface(file, steps);
				const test: SpecTest = {
					key: `${file}::${titlePath.join(' › ')}`,
					file,
					title: title.text,
					titlePath,
					line: lineOf(ctx, call.getStart(sf)),
					surface,
					steps,
					issues: []
				};
				if (dynamic || title.dynamic) test.dynamic = true;
				test.issues = checkRules(ctx, test);
				tests.push(test);
			}
		}
	};
	walk(sf.statements, [], [], false);

	const fileIssues: Issue[] = [];
	// The name must be on the marker's own line: an empty name is not filled by the next line.
	const marker = /KI-generiert,\s*geprüft von:[ \t]*(.*)/.exec(source);
	const reviewer = marker?.[1]?.trim() ?? '';
	if (marker && (!reviewer || /<name>/i.test(reviewer))) {
		const line = source.slice(0, marker.index).split('\n').length;
		fileIssues.push({
			rule: 'ai-review',
			severity: 'warning',
			message:
				'AI-generated test without a named reviewer. Whoever reviewed it puts their name in the comment at the top of the file.',
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
					const kind = own(LOCATOR_METHODS, m);
					if (!locator && kind) locator = kind;
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
