import { describe, expect, test } from 'vitest';
import { FAKE_KEY, fakeOctane } from '../../test/fake-octane.js';
import { must } from '../../test/must.js';
import {
	octaneConfig,
	octaneLink,
	queryString,
	searchQuery,
	withOctane,
	type OctaneConfig
} from './octane.js';
import { OctaneError } from './octane-error.js';

const config: OctaneConfig = {
	url: 'https://octane.example.com',
	sharedSpace: '1001',
	workspace: '1002',
	...FAKE_KEY
};

const TESTS = [
	{ id: '11', name: 'Create sales order', subtype: 'test_manual', script: '- a', phase: 'New' },
	{ id: '12', name: 'Sales order features', subtype: 'gherkin_test' },
	{ id: '13', name: 'Sales order automated', subtype: 'test_automated' }
];

const down = () => Promise.reject(new TypeError('connection refused'));
const redirect = () =>
	Promise.resolve(new Response(null, { status: 302, headers: { Location: '/ui/login' } }));

describe('octaneConfig', () => {
	test('names the settings missing, and trims the address', () => {
		expect(octaneConfig({ OCTANE_URL: 'https://x.example.com' })).toEqual({
			missing: [
				'OCTANE_SHARED_SPACE',
				'OCTANE_WORKSPACE',
				'OCTANE_CLIENT_ID',
				'OCTANE_CLIENT_SECRET'
			]
		});
		expect(
			octaneConfig({
				OCTANE_URL: ' https://octane.example.com/ ',
				OCTANE_SHARED_SPACE: '1001',
				OCTANE_WORKSPACE: '1002',
				OCTANE_CLIENT_ID: 'importer',
				OCTANE_CLIENT_SECRET: ' s3cret'
			}).config
		).toEqual({ ...config, clientSecret: ' s3cret' });
	});

	test('says what is wrong with an address or a number from the environment file', () => {
		const set = {
			OCTANE_URL: 'octane.example.com',
			OCTANE_SHARED_SPACE: '1001',
			OCTANE_WORKSPACE: '1002',
			OCTANE_CLIENT_ID: 'importer',
			OCTANE_CLIENT_SECRET: 's3cret'
		};
		expect(octaneConfig(set)).toEqual({
			missing: [],
			problem: 'OCTANE_URL is not a web address such as https://octane.example.com.'
		});
		expect(
			octaneConfig({ ...set, OCTANE_URL: 'https://o.example.com', OCTANE_WORKSPACE: 'w' }).problem
		).toMatch(/^OCTANE_WORKSPACE must be a number/);
	});

	test('links a test to its page in Octane', () => {
		expect(octaneLink(config, '11')).toBe(
			'https://octane.example.com/ui/entity-navigation?p=1001/1002&entityType=test&id=11'
		);
	});
});

describe('the query', () => {
	test('searches manual and Gherkin tests by id or by a part of the name', () => {
		const kinds = '(subtype EQ ^test_manual^||subtype EQ ^gherkin_test^)';
		expect(searchQuery('  ')).toBe(kinds);
		expect(searchQuery('42')).toBe(`${kinds};id EQ 42`);
		expect(searchQuery('sales order')).toBe(`${kinds};name EQ ^*sales order*^`);
	});

	test('escapes what would end the string or the query', () => {
		expect(queryString(`a^b"c'd\\e`)).toBe(`^a\\^b\\"c\\'d\\\\e^`);
	});
});

describe('a session', () => {
	test('signs in with the API key, sends its cookies, and signs out', async () => {
		const octane = fakeOctane(TESTS);
		const found = await withOctane(config, (s) => s.search('sales'), octane.fetch);
		expect(found.total).toBe(2);
		expect(found.tests.map((t) => [t.id, t.subtype, t.phase?.name])).toEqual([
			['11', 'test_manual', 'New'],
			['12', 'gherkin_test', undefined]
		]);
		const [signIn, search, signOut] = octane.requests;
		expect(must(signIn).method).toBe('POST');
		expect(JSON.parse(must(must(signIn).body))).toEqual({
			client_id: 'importer',
			client_secret: 's3cret'
		});
		expect(search?.cookie).toBe('LWSSO_COOKIE_KEY=abc; OCTANE_USER=importer');
		expect(search?.url.searchParams.get('query')).toBe(`"${searchQuery('sales')}"`);
		expect(search?.url.searchParams.get('limit')).toBe('50');
		expect(signOut?.url.pathname).toBe('/authentication/sign_out');
	});

	test('reads the basic fields only where Octane refuses the references', async () => {
		const octane = fakeOctane(TESTS);
		octane.basicFieldsOnly = true;
		const found = await withOctane(config, (s) => s.byIds(['11']), octane.fetch);
		expect(found).toEqual([
			{ id: '11', name: 'Create sales order', subtype: 'test_manual', description: null }
		]);
		expect(octane.requests.map((r) => r.url.searchParams.get('fields'))).toEqual([
			null,
			expect.stringContaining('product_areas{name}'),
			'id,name,subtype,description',
			null
		]);
	});

	test('reads a script, and takes ids as numbers only', async () => {
		const octane = fakeOctane(TESTS);
		await withOctane(
			config,
			async (s) => {
				expect(await s.script('11')).toBe('- a');
				await expect(s.byIds(['11) || (id GT 0'])).rejects.toThrow('Octane ids are numbers.');
			},
			octane.fetch
		);
	});

	test('refuses an answer whose ids are not numbers', async () => {
		const octane = fakeOctane([{ id: "1');\nevil()//", name: 'x', subtype: 'test_manual' }]);
		await expect(withOctane(config, (s) => s.search(''), octane.fetch)).rejects.toThrow(
			"Searching Octane: Octane's answer is not a list of tests."
		);
	});

	test('says so when the API key is wrong', async () => {
		const octane = fakeOctane(TESTS);
		const run = withOctane({ ...config, clientSecret: 'wrong' }, (s) => s.search(''), octane.fetch);
		await expect(run).rejects.toThrow(/did not accept the API access key/);
		await expect(run).rejects.toBeInstanceOf(OctaneError);
	});

	test("signs out also when the work fails, and reports Octane's description", async () => {
		const octane = fakeOctane(TESTS);
		await expect(withOctane(config, (s) => s.script('99'), octane.fetch)).rejects.toThrow(
			'Reading the steps of test 99: Octane answered 404: no such test'
		);
		expect(octane.requests.at(-1)?.url.pathname).toBe('/authentication/sign_out');
	});

	test('names the host it could not reach, and a redirect to a login page', async () => {
		await expect(withOctane(config, (s) => s.search(''), down)).rejects.toThrow(
			'Signing in to Octane: could not reach https://octane.example.com (connection refused).'
		);
		await expect(withOctane(config, (s) => s.search(''), redirect)).rejects.toThrow(/without \/ui/);
	});
});
