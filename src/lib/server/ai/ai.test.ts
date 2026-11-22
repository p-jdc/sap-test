import { describe, expect, test } from 'vitest';
import { checkAi } from './check.js';
import { aiModel } from './model.js';
import { aiReady } from '#lib/shared/ai.js';
import { aiStatus, DEFAULT_AI_MODEL } from './settings.js';

const KEY = 'foundry-key-0123456789abcdef';
const FOUNDRY = {
	TEST_APP_AI: 'foundry',
	ANTHROPIC_FOUNDRY_RESOURCE: 'lab-ai',
	ANTHROPIC_FOUNDRY_API_KEY: KEY,
	// Set by someone's shell: must never be used.
	ANTHROPIC_API_KEY: 'direct-key-must-not-be-sent'
};
const VERTEX = {
	TEST_APP_AI: 'vertex',
	GOOGLE_VERTEX_PROJECT: 'lab',
	GOOGLE_VERTEX_LOCATION: 'eu'
};
const DIRECT_KEY = 'direct-key-0123456789abcdef';
const ANTHROPIC = { TEST_APP_AI: 'anthropic', ANTHROPIC_API_KEY: DIRECT_KEY };

/** A Messages API answer as Claude sends it, on Foundry and on Vertex alike. */
const ANSWER = {
	id: 'msg_test',
	type: 'message',
	role: 'assistant',
	model: 'claude-opus-5-5',
	content: [{ type: 'text', text: 'OK' }],
	stop_reason: 'end_turn',
	stop_sequence: null,
	usage: { input_tokens: 21, output_tokens: 4 }
};

type Sent = { url: string; headers: Headers; model: unknown };

/** A stand-in for the network: records each request and answers with `status` and `body`. */
function network(status = 200, body: unknown = ANSWER) {
	const sent: Sent[] = [];
	const fake = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
		const model =
			typeof parsed === 'object' && parsed && 'model' in parsed ? parsed.model : undefined;
		sent.push({ url, headers: new Headers(init?.headers), model });
		return Promise.resolve(Response.json(body, { status }));
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fetch's extra members (preconnect) are unused
	return { sent, fetch: fake as typeof fetch };
}

describe('aiStatus', () => {
	test('the AI is off unless a provider is chosen', () => {
		expect(aiStatus({})).toEqual({ provider: 'off', missing: [] });
		expect(aiStatus({ TEST_APP_AI: 'off' })).toEqual({ provider: 'off', missing: [] });
		expect(aiReady(aiStatus({}))).toBe(false);
	});

	test.each(['openai', 'gateway', 'bedrock'])('%s is refused: only Vertex and Foundry', (name) => {
		const status = aiStatus({ TEST_APP_AI: name });
		expect(status.provider).toBe('off');
		expect(status.problem).toContain('vertex or foundry');
	});

	test('names what a provider still needs, never a value', () => {
		const status = aiStatus({ TEST_APP_AI: 'foundry', ANTHROPIC_FOUNDRY_RESOURCE: 'lab-ai' });
		expect(status.missing).toEqual(['ANTHROPIC_FOUNDRY_API_KEY']);
		expect(aiReady(status)).toBe(false);
		expect(JSON.stringify(aiStatus(FOUNDRY))).not.toContain(KEY);
	});

	test('a complete setting is ready, with the default model', () => {
		expect(aiStatus(VERTEX)).toEqual({
			provider: 'vertex',
			model: DEFAULT_AI_MODEL,
			missing: [],
			where: 'Vertex AI, project lab, location eu'
		});
		expect(aiReady(aiStatus(FOUNDRY))).toBe(true);
		expect(aiStatus({ ...FOUNDRY, TEST_APP_AI_MODEL: 'opus-eu' }).model).toBe('opus-eu');
	});

	test('a Foundry address instead of the resource name is refused', () => {
		const status = aiStatus({
			...FOUNDRY,
			ANTHROPIC_FOUNDRY_RESOURCE: 'https://lab-ai.services.ai.azure.com'
		});
		expect(status.problem).toContain('name of the Foundry resource');
		expect(aiReady(status)).toBe(false);
	});

	test('a model name with other characters is refused', () => {
		expect(aiStatus({ ...VERTEX, TEST_APP_AI_MODEL: 'a/b' }).problem).toContain(
			'TEST_APP_AI_MODEL'
		);
	});
});

test('no model is created while the AI is off or incomplete', () => {
	expect(() => aiModel({})).toThrow('The AI is off');
	expect(() => aiModel({ TEST_APP_AI: 'vertex' })).toThrow('GOOGLE_VERTEX_PROJECT');
	expect(() => aiModel({ TEST_APP_AI: 'openai' })).toThrow('vertex or foundry');
	expect(() => aiModel({ ...ANTHROPIC, HOST: '0.0.0.0' })).toThrow('local tests only');
});

describe('anthropic, the direct API', () => {
	test('works for a local app: sign-in off, on this computer', () => {
		const status = aiStatus(ANTHROPIC);
		expect(status).toMatchObject({ provider: 'anthropic', missing: [] });
		expect(status.where).toContain('local tests only');
		expect(aiReady(status)).toBe(true);
		expect(aiReady(aiStatus({ ...ANTHROPIC, HOST: '127.0.0.1' }))).toBe(true);
	});

	test.each([
		['sign-in on', { TEST_APP_AUTH: 'passkey' }],
		['HOST on the network', { HOST: '0.0.0.0' }],
		['an unknown sign-in mode', { TEST_APP_AUTH: 'maybe' }]
	])('is refused with %s', (_, extra) => {
		const status = aiStatus({ ...ANTHROPIC, ...extra });
		expect(status.problem).toContain('local tests only');
		expect(aiReady(status)).toBe(false);
	});

	test('needs its key', () => {
		expect(aiStatus({ TEST_APP_AI: 'anthropic' }).missing).toEqual(['ANTHROPIC_API_KEY']);
	});
});

describe('checkAi', () => {
	test('anthropic: the request goes to the direct API with its key', async () => {
		const net = network();
		const check = await checkAi(ANTHROPIC, { fetch: net.fetch });
		expect(check.ok).toBe(true);
		const [request] = net.sent;
		expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
		expect(request?.headers.get('x-api-key')).toBe(DIRECT_KEY);
	});

	test('Foundry: the request goes to the resource with its key, never to the direct API', async () => {
		const net = network();
		const check = await checkAi(FOUNDRY, { fetch: net.fetch });
		expect(check).toMatchObject({ ok: true, reply: 'OK', inputTokens: 21, outputTokens: 4 });
		expect(net.sent).toHaveLength(1);
		const [request] = net.sent;
		expect(request?.url).toBe('https://lab-ai.services.ai.azure.com/anthropic/v1/messages');
		expect(request?.headers.get('x-api-key')).toBe(KEY);
		expect(request?.model).toBe(DEFAULT_AI_MODEL);
		expect(JSON.stringify(net.sent)).not.toContain('direct-key-must-not-be-sent');
	});

	test('Vertex: the request goes to the EU endpoint with Google sign-in', async () => {
		const net = network();
		const check = await checkAi(VERTEX, {
			fetch: net.fetch,
			googleAuthToken: () => Promise.resolve('google-token')
		});
		expect(check.ok).toBe(true);
		const [request] = net.sent;
		expect(request?.url).toBe(
			'https://aiplatform.eu.rep.googleapis.com/v1/projects/lab/locations/eu/publishers/anthropic/models/claude-opus-5-5:rawPredict'
		);
		expect(request?.headers.get('authorization')).toBe('Bearer google-token');
	});

	test('a refusal by the provider is reported without the key', async () => {
		const net = network(401, {
			type: 'error',
			error: { type: 'authentication_error', message: `invalid key ${KEY}` }
		});
		const check = await checkAi(FOUNDRY, { fetch: net.fetch });
		expect(check.ok).toBe(false);
		expect(JSON.stringify(check)).not.toContain(KEY);
	});

	test('nothing is sent while the AI is off', async () => {
		const net = network();
		const check = await checkAi({}, { fetch: net.fetch });
		expect(check).toMatchObject({ ok: false });
		expect(JSON.stringify(check)).toContain('The AI is off');
		expect(net.sent).toHaveLength(0);
	});
});
