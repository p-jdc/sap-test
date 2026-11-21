// Lint rules for the SAP test rules in sap-tests/CLAUDE.md that a machine can decide. The Test-App
// shows the same findings per test (app/src/lib/server/spec-parser.ts); these fail the lint run.
import { defineRule, eslintCompatPlugin } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

/** Methods that type a value into a field and write it into the report's step title. */
const TYPING = new Set(['fill', 'type', 'pressSequentially']);

/** A locator that names a password field: getByLabel('Password'), getByRoleSID(…, { name: 'Kennwort' }). */
const PASSWORD_FIELD = /passwor[dt]|kennwort|\bpwd\b/i;

/** A value that is a password by its name: process.env.SAP_PASSWORD, user.password, pwd. */
const PASSWORD_VALUE = /passwor[dt]|kennwort|pwd|secret/i;

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

/** A non-empty string written into the code: 'x', `x`, 'x' + 'y'. */
function isLiteralText(node: ESTree.Node | undefined): boolean {
	if (!node) return false;
	const inner = unwrapped(node);
	if (inner.type === 'Literal') return typeof inner.value === 'string' && inner.value !== '';
	if (inner.type === 'TemplateLiteral')
		return inner.expressions.length === 0 && inner.quasis.some((q) => q.value.raw !== '');
	if (inner.type === 'BinaryExpression' && inner.operator === '+')
		return isLiteralText(inner.left) && isLiteralText(inner.right);
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
				const [value] = node.arguments;
				if (!value) return;
				const field = context.sourceCode.getText(callee.object);
				const text = context.sourceCode.getText(value);
				// A literal is no password by its name: getByLabel('Search').fill('secret santa').
				const namedPassword = !isLiteralText(value) && PASSWORD_VALUE.test(text);
				if (PASSWORD_FIELD.test(field) || namedPassword)
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
				if (isLiteralText(password))
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
