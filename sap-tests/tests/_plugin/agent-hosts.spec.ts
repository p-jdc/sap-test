// KI-generiert, geprüft von: <Name>
// The host limit of a test agent's session (sap-plugin/agent-hosts.ts): with it, the browser
// reaches the session's hosts and nothing else, whatever a page or a script in it tries.
import { createServer, type Server } from 'node:http';
import { expect, test } from '../../sap-plugin';
import { agentHosts, agentProxy, hostAllowed, limitHosts } from '../../sap-plugin/agent-hosts';

function portOf(server: Server): number {
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The server has no port.');
	return address.port;
}

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

test.describe('behind the proxy of a session', () => {
	// What the app starts for a planner session (src/lib/server/agent-proxy.ts), here as a small
	// stand-in: it serves `allowed.test` itself and refuses every other host. The browser asks it
	// for every address, also for the target of a redirect and for addresses of this computer.
	const asked: string[] = [];
	let proxy: Server;
	let local: Server;
	let localPort = 0;

	test.beforeAll(async () => {
		local = createServer((_request, response) => response.end('this computer'));
		await new Promise<void>((resolve) => {
			local.listen(0, '127.0.0.1', resolve);
		});
		localPort = portOf(local);
		proxy = createServer((request, response) => {
			const url = new URL(request.url ?? '');
			asked.push(url.href);
			if (url.host !== 'allowed.test') response.writeHead(403).end();
			else if (url.pathname === '/redirect')
				response.writeHead(302, { location: `http://127.0.0.1:${localPort}/settings` }).end();
			else response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>inside</h1>');
		});
		proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
		await new Promise<void>((resolve) => {
			proxy.listen(0, '127.0.0.1', resolve);
		});
	});
	test.afterAll(() => {
		proxy.close();
		local.close();
	});

	test('a redirect of an allowed host to this computer is refused, as a page and from a script', async ({
		browser
	}) => {
		const context = await browser.newContext({
			proxy: {
				server: `http://127.0.0.1:${portOf(proxy)}`,
				bypass: agentProxy()?.bypass ?? '<-loopback>'
			}
		});
		const page = await context.newPage();
		await page.goto('http://allowed.test/');
		await expect(page.getByRole('heading')).toHaveText('inside');

		const response = await page.goto('http://allowed.test/redirect');
		expect(response?.status()).toBe(403);
		await expect(page.getByText('this computer')).toBeHidden();

		await page.goto('http://allowed.test/');
		const fetched = await page.evaluate(() =>
			fetch('/redirect').then(
				(r) => r.status,
				() => 'failed'
			)
		);
		expect(fetched).not.toBe(200);
		// Both times the browser asked the proxy for the redirect's target and did not go there itself.
		expect(asked.filter((url) => url.includes('/settings'))).toHaveLength(2);
		await context.close();
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
