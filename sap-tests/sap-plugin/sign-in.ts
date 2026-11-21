// Signs in to a system of systems.json with the method it names. Runs in setup/sign-in.setup.ts,
// which has no trace (see session.ts); the tests start with the session it saves.
import { expect, type Locator, type Page } from '@playwright/test';
import { sapLogin, sapLoginPage } from './login';
import { fillSecret } from './secret';
import type { SignInSystem } from './systems';

type Form = { user: Locator; password: Locator; submit: Locator };

/**
 * SAP Cloud Identity Services. Found by the fields' names, which stay the same in every language
 * and with a tenant's own texts.
 */
const iasForm = (page: Page): Form => ({
	user: page.locator('input[name="j_username"]'),
	password: page.locator('input[name="j_password"]'),
	submit: page
		.locator('#logOnFormSubmit')
		.or(page.locator('button[type="submit"]'))
		.filter({ visible: true })
		.first()
});

const labelledForm = (
	page: Page,
	labels: { user: string; password: string; submit: string }
): Form => ({
	user: page.getByLabel(labels.user, { exact: true }),
	password: page.getByLabel(labels.password, { exact: true }),
	submit: page.getByRole('button', { name: labels.submit, exact: true })
});

async function fillForm(
	page: Page,
	form: Form,
	system: SignInSystem,
	user: string,
	password: string
) {
	const { env } = system;
	await expect(form.user, `No login page of ${system.title} found at ${env.url}`).toBeVisible({
		timeout: 30_000
	});
	const loginOrigin = new URL(page.url()).origin;
	await form.user.fill(user);
	// A page that asks for the user first shows the password field only after the button.
	if (!(await form.password.isVisible())) {
		await form.submit.click();
		await expect(
			form.password,
			`No password field after the user name: check ${env.user}`
		).toBeVisible();
	}
	await fillSecret(form.password, password);
	await form.submit.click();
	await expect(
		form.password,
		`Still on the login page: check ${env.user} and ${env.password}`
	).toBeHidden();
	// Signed in at an identity service (another host than the system): wait until it has sent the
	// browser back, so the system's own session is in the saved state.
	if (loginOrigin !== new URL(process.env[env.url]!).origin)
		await page.waitForURL((url) => url.origin !== loginOrigin);
	await page.waitForLoadState();
}

/** Signs in with the address, user and password from the system's environment variables. */
export async function signIn(page: Page, system: SignInSystem) {
	const { env, signIn: how } = system;
	const url = process.env[env.url]!;
	const user = process.env[env.user]!;
	const password = process.env[env.password]!;
	if (how.method === 'sapLogin') {
		await sapLogin(page, user, password, url);
		await expect(
			sapLoginPage(page),
			`Still on the login page: check ${env.user} and ${env.password}`
		).toBeHidden();
		return;
	}
	await page.goto(url);
	await fillForm(
		page,
		how.method === 'ias' ? iasForm(page) : labelledForm(page, how),
		system,
		user,
		password
	);
}
