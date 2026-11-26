// KI-generiert, geprüft von: <Name>
// The host limit of a test agent's session (sap-plugin/agent-hosts.ts): with it, the browser
// reaches the session's hosts and nothing else, whatever a page or a script in it tries.
import { expect, test } from '../../sap-plugin';
import { agentHosts, hostAllowed, limitHosts } from '../../sap-plugin/agent-hosts';

const PAGE =
	'<html><body><a href="http://elsewhere.test/next">out</a><h1>inside</h1></body></html>';

test.describe('the host limit of an agent session', () => {
	test.beforeEach(async ({ context }) => {
		// Both hosts answer, so that only the limit decides what the browser gets.
		await context.route('**/*', (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: PAGE.replace('inside', route.request().url())
			})
		);
		await limitHosts(context, agentHosts('app.test, cdn.test:8443'));
	});

	// A blocked page ends on the browser's own error page, not on the address asked for.
	const BLOCKED = 'chrome-error://chromewebdata/';

	test('opens a session host, and no other by its address', async ({ page }) => {
		await page.goto('http://app.test/start');
		await expect(page.getByRole('heading')).toHaveText('http://app.test/start');
		await expect(page.goto('http://elsewhere.test/')).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
	});

	test("does not follow the application's link to another host", async ({ page }) => {
		await page.goto('http://app.test/start');
		await page.getByRole('link', { name: 'out' }).click();
		await expect(page).toHaveURL(BLOCKED);
	});

	test('a script cannot send the browser to this computer', async ({ page }) => {
		await page.goto('http://app.test/start');
		await page.evaluate(() => {
			location.href = 'http://127.0.0.1:9/settings';
		});
		await expect(page).toHaveURL(BLOCKED);
	});

	test('sends nothing to another host from a script', async ({ page }) => {
		await page.goto('http://app.test/start');
		const send = (url: string) =>
			page.evaluate(
				(to) =>
					fetch(to, { method: 'POST', body: 'what the screen showed', mode: 'no-cors' }).then(
						() => 'sent',
						() => 'blocked'
					),
				url
			);
		expect(await send('http://elsewhere.test/collect')).toBe('blocked');
		expect(await send('http://localhost:3000/')).toBe('blocked');
		expect(await send('http://cdn.test:8443/lib.js')).toBe('sent');
		// The same host on another port is another host.
		expect(await send('http://cdn.test/lib.js')).toBe('blocked');
	});

	test('a popup is limited too', async ({ page, context }) => {
		await page.goto('http://app.test/start');
		const [popup] = await Promise.all([
			context.waitForEvent('page'),
			page.evaluate(() => {
				window.open('http://elsewhere.test/popup');
			})
		]);
		await expect(popup).toHaveURL(BLOCKED);
		await expect(popup.getByRole('heading')).toBeHidden();
	});
});

test('without a host, nothing is limited', async ({ context, page }) => {
	await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
	await limitHosts(context, agentHosts(undefined, ''));
	await page.goto('http://elsewhere.test/');
	await expect(page.getByRole('heading')).toHaveText('inside');
});

test('hostAllowed judges the real host of an address', () => {
	const hosts = agentHosts('App.test');
	expect(hostAllowed('https://app.test/a', hosts)).toBe(true);
	expect(hostAllowed('wss://app.test/socket', hosts)).toBe(true);
	expect(hostAllowed('about:blank', hosts)).toBe(true);
	expect(hostAllowed('data:text/html,x', hosts)).toBe(true);
	expect(hostAllowed('https://app.test@elsewhere.test/', hosts)).toBe(false);
	expect(hostAllowed('https://app.test.elsewhere.test/', hosts)).toBe(false);
	expect(hostAllowed('file:///etc/hosts', hosts)).toBe(false);
	expect(hostAllowed('not an address', hosts)).toBe(false);
});
