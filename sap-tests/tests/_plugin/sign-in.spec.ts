// Checks the sign-in methods of systems.json (sap-plugin/sign-in.ts) and the checks on that file
// (sap-plugin/systems.ts), against stand-in login pages: an application at app.test and an
// identity service at ias.test that sends the browser back to it.
import {
	test,
	expect,
	signIn,
	signingIn,
	testFiles,
	type Page,
	type SignInMethod,
	type SignInSystem
} from '../../sap-plugin';
import { parseSystems } from '../../sap-plugin/systems';
import { systemOfFile } from '../../sap-plugin/systems-schema';

const APP = 'https://app.test';
const IAS = 'https://ias.test';
const PASSWORD = 'pw "1"';

const env = { url: 'STANDIN_URL', user: 'STANDIN_USER', password: 'STANDIN_PASS' };
const system = (method: SignInMethod): SignInSystem => ({
	id: 'standin',
	title: 'Stand-in',
	signIn: method,
	env,
	tests: ['standin']
});

test.beforeEach(() => {
	process.env[env.url] = `${APP}/start`;
	process.env[env.user] = 'tester';
	process.env[env.password] = PASSWORD;
});
test.afterEach(() => {
	for (const name of Object.values(env)) delete process.env[name];
});

const html = (body: string) => ({ contentType: 'text/html', body: `<!doctype html>${body}` });
// Sends the browser on by script, as an identity service's SAML response does: Chromium does not
// route the target of a faked 302 back through page.route.
const redirect = (location: string, cookie?: string) => ({
	...html(`<script>location.replace(${JSON.stringify(location)})</script>`),
	headers: cookie ? { 'set-cookie': cookie } : {}
});

// SAP Cloud Identity Services, with the field names IAS uses. `userFirst` asks for the password on
// a second step, after the button.
const iasPage = (userFirst: boolean) =>
	html(`<form method="post" action="${IAS}/login"
	onsubmit="const pw = document.getElementById('pw'); if (pw.hidden) { event.preventDefault(); pw.hidden = false; }">
<label>E-Mail or User Name <input name="j_username" /></label>
<label ${userFirst ? 'hidden' : ''} id="pw">Password <input name="j_password" type="password" /></label>
<button id="logOnFormSubmit" type="submit">Continue</button>
</form>`);

const FORM_PAGE = html(`<form method="post" action="${APP}/login">
<label>User Name <input name="u" /></label><label>Password <input name="p" type="password" /></label>
<button>Login</button></form>`);

/** Routes both hosts. Sign-ins with the right password end on app.test/home with a session cookie. */
async function standIns(page: Page, login: 'ias' | 'ias-user-first' | 'form') {
	await page.route(`${APP}/**`, async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === '/start') {
			const signedIn = (await route.request().allHeaders()).cookie?.includes('APP_SESSION=ok');
			if (signedIn) return route.fulfill(html('<h1>Home</h1>'));
			return route.fulfill(login === 'form' ? FORM_PAGE : redirect(`${IAS}/saml2/idp/sso`));
		}
		if (url.pathname === '/login' || url.pathname === '/acs') {
			const body = new URLSearchParams(route.request().postData() ?? url.search);
			const ok = body.get('p') === PASSWORD || body.get('token') === 'ok';
			return route.fulfill(ok ? redirect(`${APP}/home`, 'APP_SESSION=ok; Path=/') : FORM_PAGE);
		}
		return route.fulfill(html('<h1>Home</h1>'));
	});
	await page.route(`${IAS}/**`, async (route) => {
		const request = route.request();
		if (request.method() !== 'POST') return route.fulfill(iasPage(login === 'ias-user-first'));
		const ok = new URLSearchParams(request.postData() ?? '').get('j_password') === PASSWORD;
		// oxlint-disable-next-line browser-security/no-credentials-in-query-params -- a stand-in for the redirect of a login page; "ok" is no credential
		return route.fulfill(ok ? redirect(`${APP}/acs?token=ok`) : iasPage(false));
	});
}

async function expectSignedIn(page: Page) {
	expect(new URL(page.url()).origin).toBe(APP);
	await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
	const cookies = await page.context().cookies(APP);
	expect(cookies.map((c) => c.name)).toContain('APP_SESSION');
}

test('signIn ias: signs in at the identity service and waits until it sends you back', async ({
	page
}) => {
	await standIns(page, 'ias');
	await signIn(page, system({ method: 'ias' }));
	await expectSignedIn(page);
});

test('signIn ias: a login page that asks for the user first', async ({ page }) => {
	await standIns(page, 'ias-user-first');
	await signIn(page, system({ method: 'ias' }));
	await expectSignedIn(page);
});

test('signIn form: finds the fields by their labels', async ({ page }) => {
	await standIns(page, 'form');
	await signIn(
		page,
		system({ method: 'form', user: 'User Name', password: 'Password', submit: 'Login' })
	);
	await expectSignedIn(page);
});

test('signIn: a wrong password names the variables to check and leaves no password', async ({
	page
}) => {
	process.env[env.password] = 'wrong';
	await standIns(page, 'ias');
	await expect(signingIn(page, () => signIn(page, system({ method: 'ias' })))).rejects.toThrow(
		'Still on the login page: check STANDIN_USER and STANDIN_PASS'
	);
	await expect(page.locator('input[name="j_password"]')).toHaveValue('');
});

const table = (systems: unknown[]) => JSON.stringify({ systems });
const row = (extra: Record<string, unknown> = {}) => ({
	id: 'sap',
	title: 'SAP',
	signIn: { method: 'sapLogin' },
	env: { url: 'SAP_URL', user: 'SAP_USERNAME', password: 'SAP_PASSWORD' },
	tests: ['fiori'],
	...extra
});

test('systems.json: refuses rows that would not sign in or would run a test twice', () => {
	const bad: [unknown[], RegExp][] = [
		[[row({ signIn: { method: 'sso' } })], /method must be "sapLogin", "ias" or "form"/],
		[[row({ signIn: { method: 'form', user: 'User' } })], /needs "user", "password" and "submit"/],
		[[row({ env: { url: 'SAP_HOST', user: 'U', password: 'P' } })], /must end with _URL/],
		[[row({ id: 'chromium' })], /not "chromium"/],
		[[row({ tests: ['../x'] })], /list of folders under tests/],
		[[row({ exclude: ['webgui/x'] })], /not inside one of its tests folders/],
		[[row(), row({ id: 'sap' })], /used twice/],
		// One variable for two systems would type one system's password into the other.
		[
			[
				row(),
				row({
					id: 'ariba',
					tests: ['ariba'],
					env: { url: 'ARIBA_URL', user: 'ARIBA_USER', password: 'SAP_PASSWORD' }
				})
			],
			/the setting SAP_PASSWORD is used twice/
		],
		[[row({ env: { url: 'SAP_API_URL', user: 'U', password: 'P' } })], /SAP_API_URL is used twice/],
		[[row({ env: { url: 'SAP_URL', user: 'U', password: 'U' } })], /the setting U is used twice/],
		[
			[row({ env: { url: 'SAP_URL', user: 'NODE_OPTIONS', password: 'P' } })],
			/"NODE_OPTIONS" is a variable other programs read/
		],
		[[row(), row({ id: 'other', tests: ['fiori/x'] })], /both claim tests\/fiori\/x/]
	];
	for (const [systems, message] of bad) expect(() => parseSystems(table(systems))).toThrow(message);
	expect(parseSystems(table([row()]))).toEqual([row()]);
});

test('systems.json: a system holds the tests of its folders, without the excluded ones', () => {
	const files = testFiles({
		...system({ method: 'sapLogin' }),
		tests: ['fiori', '_reference'],
		exclude: ['fiori/demokit']
	});
	for (const file of ['/r/tests/fiori/a.spec.ts', String.raw`C:\r\tests\_reference\b.spec.ts`])
		expect(file).toMatch(files);
	for (const file of [
		'/r/tests/fiori/demokit/a.spec.ts',
		'/r/tests/fiori-x/a.spec.ts',
		'/r/tests/webgui/a.spec.ts'
	])
		expect(file).not.toMatch(files);
});

test('systems.json: the test app assigns each file to the system whose projects run it', () => {
	const sap = {
		...system({ method: 'sapLogin' }),
		tests: ['fiori', '_reference'],
		exclude: ['fiori/demokit']
	};
	const other = { ...system({ method: 'ias' }), id: 'other', tests: ['other'] };
	for (const file of [
		'fiori/a.spec.ts',
		'_reference/b.spec.ts',
		'fiori/demokit/a.spec.ts',
		'fiori-x/a.spec.ts',
		'other/c.spec.ts',
		'_demo/d.spec.ts'
	]) {
		const project = [sap, other].find((s) => `/r/tests/${file}`.match(testFiles(s)));
		expect(systemOfFile(file, [sap, other])?.id, file).toBe(project?.id);
	}
});
