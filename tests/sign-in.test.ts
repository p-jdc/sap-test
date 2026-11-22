import { expect, test, type Browser, type Page } from '@playwright/test';
import { z } from 'zod';

// Sign-in with passkeys, against the second preview server (playwright.config.ts): sign-in on,
// an empty data directory, a fixed setup token and a fixed recovery token. Chrome's virtual authenticator stands in for
// the passkey store of a computer (Touch ID, Windows Hello, a security key). It belongs to one
// page, so the admin keeps one page across these tests, which run in order.
const APP = 'http://localhost:4181';
const SETUP = 'e2e-setup-token-0123456789abcdef';
const RECOVER = 'e2e-recovery-token-0123456789abcdef';

test.describe.configure({ mode: 'serial' });

/** A new browser window with its own passkey store, like another person's computer. */
async function person(browser: Browser): Promise<Page> {
	const page = await (await browser.newContext()).newPage();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	return page;
}

const button = (page: Page, text: string) => page.locator('ui5-button', { hasText: text });
const signOutItem = (page: Page) =>
	page.locator('ui5-side-navigation-item[data-action="sign-out"]');

let admin: Page;
test.beforeAll(async ({ browser }) => {
	admin = await person(browser);
});
test.afterAll(async () => {
	await admin.context().close();
});

test('signed out, the app shows only the sign-in page and answers data requests with 401', async ({
	page,
	request
}) => {
	await page.goto(`${APP}/settings`);
	await expect(page).toHaveURL(`${APP}/signin?redirect=%2Fsettings`);
	await expect(page.getByText('shows a link to create the first account')).toBeVisible();

	// From the app's own origin, past SvelteKit's cross-site check, to the sign-in check.
	const data = await request.post(`${APP}/_app/remote/any/getRuns`, {
		headers: { origin: APP },
		maxRedirects: 0
	});
	expect(data.status()).toBe(401);
	const file = await request.get(`${APP}/runs/20260101-000000-abcd/files/trace.zip`, {
		maxRedirects: 0
	});
	expect(file.status()).toBe(401);
	const state = await request.get(`${APP}/api/signin-state`);
	expect(await state.json()).toEqual({
		on: true,
		signedIn: false,
		needsSetup: true,
		setup: false,
		recover: false,
		invite: null
	});
});

test('the setup link registers the first admin, who signs out and in again with the passkey', async () => {
	// A wrong setup token gives no form.
	await admin.goto(`${APP}/signin?setup=wrong`);
	await expect(admin.getByText('shows a link to create the first account')).toBeVisible();

	await admin.goto(`${APP}/signin?setup=${SETUP}`);
	await admin.locator('#name').locator('input').fill('Ada Admin');
	await button(admin, 'Create a passkey').click();
	await expect(admin).toHaveURL(`${APP}/`);
	await expect(signOutItem(admin)).toHaveAttribute('text', 'Sign out: Ada Admin (admin)');

	await signOutItem(admin).click();
	await expect(admin).toHaveURL(`${APP}/signin`);
	await button(admin, 'Sign in with a passkey').click();
	await expect(admin).toHaveURL(`${APP}/`);
	await expect(signOutItem(admin)).toHaveAttribute('text', 'Sign out: Ada Admin (admin)');
});

test('the setup link is spent once someone is registered', async ({ browser }) => {
	const late = await person(browser);
	await late.goto(`${APP}/signin?setup=${SETUP}`);
	await expect(button(late, 'Sign in with a passkey')).toBeVisible();
	await expect(late.locator('#name')).toHaveCount(0);
	await late.context().close();
});

test('an admin invites a member, who registers once, cannot change settings, is blocked, promoted and removed', async ({
	browser
}) => {
	await admin.goto(`${APP}/settings`);
	await admin.locator('#invite-name').locator('input').fill('Max Member');
	await button(admin, 'Create invite link').click();
	const link = (await admin.locator('[data-invite-link]').textContent())?.trim() ?? '';
	expect(link).toMatch(/^http:\/\/localhost:4181\/signin\?invite=[\w-]{20,}$/);

	const member = await person(browser);
	await member.goto(link);
	await expect(member.getByText('Welcome, Max Member.')).toBeVisible();
	await button(member, 'Create a passkey').click();
	await expect(member).toHaveURL(`${APP}/`);
	await expect(signOutItem(member)).toHaveAttribute('text', 'Sign out: Max Member');

	await member.goto(`${APP}/settings`);
	await expect(member.getByText('Only an admin can change these settings.')).toBeVisible();
	await expect(member.getByText('People')).toHaveCount(0);

	// The invite works once.
	const again = await person(browser);
	await again.goto(link);
	await expect(again.getByText('This invite link is not valid any more.')).toBeVisible();
	await again.context().close();

	const row = admin.locator('[data-person="Max Member"]');
	const action = (text: string) => row.locator('ui5-button', { hasText: text });

	// Blocked, the member is signed out and cannot sign in again until unblocked.
	await admin.reload();
	await action('Block').click();
	await expect(row).toContainText('Max Member (blocked)');
	await member.reload();
	await expect(member).toHaveURL(/\/signin/);
	await button(member, 'Sign in with a passkey').click();
	await expect(member.getByText('Your access is blocked.')).toBeVisible();
	await action('Unblock').click();
	await expect(row).not.toContainText('(blocked)');
	await button(member, 'Sign in with a passkey').click();
	// Back where they were.
	await expect(member).toHaveURL(`${APP}/settings`);

	// Promoted, the member is an admin at their next page.
	await action('Make admin').click();
	// The button turns once the role has changed ("admin" alone is also in "Make admin").
	await expect(action('Make member')).toBeVisible();
	await member.reload();
	await expect(signOutItem(member)).toHaveAttribute('text', 'Sign out: Max Member (admin)');
	await action('Make member').click();

	// The last admin keeps the role, also through Better Auth's own endpoint.
	const me = await admin.request.get(`${APP}/api/auth/get-session`);
	const myId = z.object({ user: z.object({ id: z.string() }) }).parse(await me.json()).user.id;
	const demote = await admin.request.post(`${APP}/api/auth/admin/set-role`, {
		headers: { origin: APP },
		data: { userId: myId, role: 'member' }
	});
	expect(demote.status()).toBe(400);
	expect(await demote.text()).toContain('The last admin keeps the role.');

	// Removed, the member is signed out at their next request.
	admin.once('dialog', (dialog) => void dialog.accept());
	await admin.locator('[data-person="Max Member"] ui5-button', { hasText: 'Remove' }).click();
	await expect(admin.locator('[data-person="Max Member"]')).toHaveCount(0);
	await member.reload();
	await expect(member).toHaveURL(/\/signin/);
	await member.context().close();

	// The activity log tells what happened.
	await admin.reload();
	await expect(admin.getByText('Registered: as admin', { exact: true })).toBeVisible();
	await expect(admin.getByText('Invited: Max Member as member', { exact: true })).toBeVisible();
	await expect(admin.getByText('Blocked: Max Member', { exact: true })).toBeVisible();
	await expect(admin.getByText('Made admin: Max Member', { exact: true })).toBeVisible();
	await expect(admin.getByText('Removed: Max Member', { exact: true })).toBeVisible();
});

test('a recovery link registers a new admin once, for when no admin can sign in', async ({
	browser
}) => {
	// Another computer: the admin's passkey is lost.
	const again = await person(browser);
	await again.goto(`${APP}/signin?recover=wrong`);
	await expect(again.getByText('This recovery link is not valid any more.')).toBeVisible();

	await again.goto(`${APP}/signin?recover=${RECOVER}`);
	await expect(again.getByText('Recover admin access')).toBeVisible();
	await again.locator('#name').locator('input').fill('Ada Again');
	await button(again, 'Create a passkey').click();
	await expect(again).toHaveURL(`${APP}/`);
	await expect(signOutItem(again)).toHaveAttribute('text', 'Sign out: Ada Again (admin)');

	// The new admin removes the old account and sees in the activity log how they got in.
	await again.goto(`${APP}/settings`);
	again.once('dialog', (dialog) => void dialog.accept());
	await again.locator('[data-person="Ada Admin"] ui5-button', { hasText: 'Remove' }).click();
	await expect(again.locator('[data-person="Ada Admin"]')).toHaveCount(0);
	await expect(
		again.getByText('Registered: as admin with a recovery link', { exact: true })
	).toBeVisible();

	// The link works once.
	const other = await person(browser);
	await other.goto(`${APP}/signin?recover=${RECOVER}`);
	await expect(other.getByText('This recovery link is not valid any more.')).toBeVisible();
	await other.context().close();
	await again.context().close();
});
