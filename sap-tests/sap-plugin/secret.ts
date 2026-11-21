// Typing a password without writing it into the test's records.
import { randomBytes } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { isInsecureHttp } from './secure-url';

/**
 * Types `secret` into a password field (`<input type="password">`) without it showing up in the
 * step titles. `locator.fill(password)` puts the value into its title (`Fill "…"`), and so into
 * the HTML report of every run and the Test-App's run data.
 *
 * Here the value reaches the page through a binding with a random name that answers once and is
 * removed right after; the step list shows only "Evaluate". Only password fields are accepted:
 * they show dots in screenshots and videos, where any other field would show the value.
 *
 * A trace still holds the password, like any trace of a browser login: the page snapshots of later
 * steps record the field's value, and the network log records the login request.
 *
 * Like `fill`, it waits for the field to be visible and replaces what is in it. It refuses a page
 * loaded over http:// from another computer, where the password would be sent unencrypted.
 */
export async function fillSecret(field: Locator, secret: string): Promise<void> {
	await field.waitFor();
	// The field's own document: a login form can sit in a frame of another address.
	const address = await field.evaluate((element) => element.ownerDocument.location.href);
	if (isInsecureHttp(address)) {
		throw new Error(
			`fillSecret: ${new URL(address).origin} is not https://, so the password would cross the network unencrypted. Use the system's https:// address.`
		);
	}
	const name = `__sapSecret_${randomBytes(12).toString('hex')}`;
	let handedOver = false;
	const binding = await field.page().exposeBinding(name, () => {
		// A second call means something else on the page asked for it.
		if (handedOver) throw new Error('fillSecret: the value was already handed over');
		handedOver = true;
		return secret;
	});
	try {
		await field.evaluate(async (element, bindingName) => {
			if (!(element instanceof HTMLInputElement) || element.type !== 'password') {
				throw new Error(
					'fillSecret: only for password fields (<input type="password">). Other fields show their value in screenshots and videos.'
				);
			}
			if (element.disabled || element.readOnly) {
				throw new Error('fillSecret: the password field is not editable');
			}
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-reflect-get -- the binding exposed above, a global whose name is made up at run time
			const read = Reflect.get(window, bindingName) as () => Promise<string>;
			const value = await read();
			element.focus();
			element.select();
			// Like typing: UI5 and other frameworks see the usual beforeinput and input events.
			if (!document.execCommand('insertText', false, value) || element.value !== value) {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
					element,
					value
				);
				element.dispatchEvent(new Event('input', { bubbles: true }));
				element.dispatchEvent(new Event('change', { bubbles: true }));
			}
		}, name);
	} finally {
		await binding.dispose();
	}
}
