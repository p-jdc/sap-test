// Lint rules for the SAP test rules in sap-tests/CLAUDE.md that a machine can decide. The Test-App
// shows the same findings per test (app/src/lib/server/spec-parser.ts); these fail the lint run.
import { defineRule, eslintCompatPlugin } from '@oxlint/plugins';
import type { ESTree, Scope, SourceCode } from '@oxlint/plugins';

/** Methods that type a value into a field and write it into the report's step title. */
const TYPING = new Set(['fill', 'type', 'pressSequentially']);

const WORDS = 'passwor[dt]|kennwort|pwd';

/**
 * A locator that names a password field: getByLabel('Password'), getByRoleSID(…, { name:
 * 'Kennwort' }), '#password', passwordField. Whole words only, so 'Passwortrichtlinie' is none.
 */
const PASSWORD_FIELD = new RegExp(String.raw`\b(?:${WORDS})(?:Field|Input|Box)?\b`, 'i');

/**
 * A value that is a password by its name: SAP_PASSWORD, password, userPassword, clientSecret. The
 * word ends the name or a part of it, so `secretary` and `passwordPolicy` are none.
 */
const PASSWORD_NAME = new RegExp(String.raw`(?:${WORDS}|secret)(?:$|[_0-9])`, 'i');

/** `value!`, `(value)`, `value as string`: the expression underneath. */
function unwrapped(node: ESTree.Node): ESTree.Node {
	if (
		node.type === 'TSNonNullExpression' ||
		node.type === 'ParenthesizedExpression' ||
		node.type === 'TSAsExpression'
	)
		return unwrapped(node.expression);
	return node;
}

/** What a `const` was declared with, for a name used as an argument. */
function constantValue(sourceCode: SourceCode, name: ESTree.Node): ESTree.Node | undefined {
	if (name.type !== 'Identifier') return undefined;
	let scope: Scope | null = sourceCode.getScope(name);
	while (scope !== null) {
		const variable = scope.set.get(name.name);
		if (variable) {
			const [definition] = variable.defs;
			const declarator = definition?.node;
			const isConst =
				definition?.parent?.type === 'VariableDeclaration' && definition.parent.kind === 'const';
			return isConst && declarator?.type === 'VariableDeclarator'
				? (declarator.init ?? undefined)
				: undefined;
		}
		scope = scope.upper;
	}
	return undefined;
}

/**
 * A non-empty string written into the code: 'x', `x`, 'x' + 'y', or a `const` holding one
 * (`depth` stops a constant that names itself).
 */
function isLiteralText(sourceCode: SourceCode, node: ESTree.Node | undefined, depth = 0): boolean {
	if (!node || depth > 5) return false;
	const inner = unwrapped(node);
	const constant = constantValue(sourceCode, inner);
	if (constant) return isLiteralText(sourceCode, constant, depth + 1);
	if (inner.type === 'Literal') return typeof inner.value === 'string' && inner.value !== '';
	if (inner.type === 'TemplateLiteral')
		return inner.expressions.length === 0 && inner.quasis.some((q) => q.value.raw !== '');
	if (inner.type === 'BinaryExpression' && inner.operator === '+')
		return (
			isLiteralText(sourceCode, inner.left, depth) && isLiteralText(sourceCode, inner.right, depth)
		);
	return false;
}

/** The name a call goes by: `fillSecret` for fillSecret(…), `SAPLogin` for page.SAPLogin(…). */
function calledName(callee: ESTree.Node): string | undefined {
	if (callee.type === 'Identifier') return callee.name;
	if (
		callee.type === 'MemberExpression' &&
		!callee.computed &&
		callee.property.type === 'Identifier'
	)
		return callee.property.name;
	return undefined;
}

/** The last name of a value: `password` for user.password, `SAP_PASSWORD` for process.env.SAP_PASSWORD!. */
function valueName(node: ESTree.Node): string | undefined {
	const inner = unwrapped(node);
	if (inner.type === 'Identifier') return inner.name;
	if (inner.type !== 'MemberExpression') return undefined;
	if (!inner.computed && inner.property.type === 'Identifier') return inner.property.name;
	return inner.property.type === 'Literal' && typeof inner.property.value === 'string'
		? inner.property.value
		: undefined;
}

const noSecretFill = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Passwords are typed with fillSecret from sap-plugin: fill, type and pressSequentially write the value into the report and the run data.'
		},
		messages: {
			secretFill:
				'`{{method}}` writes the password into the report and the run data of the Test-App. Use `fillSecret(locator, value)` from sap-plugin.'
		}
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				const { callee } = node;
				if (callee.type !== 'MemberExpression' || callee.computed) return;
				if (callee.property.type !== 'Identifier' || !TYPING.has(callee.property.name)) return;
				// locator.fill(value), or the older page.fill(selector, value).
				const [first, second] = node.arguments;
				const value = second ?? first;
				if (!value) return;
				const field = context.sourceCode.getText(second ? first : callee.object);
				const name = valueName(value);
				if (PASSWORD_FIELD.test(field) || (name !== undefined && PASSWORD_NAME.test(name)))
					context.report({
						node,
						messageId: 'secretFill',
						data: { method: callee.property.name }
					});
			}
		};
	}
});

const noLiteralSecret = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'A password written into a test ends up in git. Read it from the environment (.env or the Settings page).'
		},
		messages: {
			literalSecret:
				'Password written into the code. Read it from the environment, for example `process.env.SAP_PASSWORD!`.'
		}
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				const name = calledName(node.callee);
				// fillSecret(field, value) and page.SAPLogin(username, password, url).
				if (name !== 'fillSecret' && name !== 'SAPLogin') return;
				const password = node.arguments[1];
				if (isLiteralText(context.sourceCode, password))
					context.report({ node: password ?? node, messageId: 'literalSecret' });
			}
		};
	}
});

export default eslintCompatPlugin({
	meta: { name: 'sap' },
	rules: {
		'no-secret-fill': noSecretFill,
		'no-literal-secret': noLiteralSecret
	}
});
