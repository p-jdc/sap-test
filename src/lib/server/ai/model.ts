import { createAnthropic } from '@ai-sdk/anthropic';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { aiReady } from '#lib/shared/ai.js';
import { aiStatus } from './settings.js';

type Env = Record<string, string | undefined>;

/** Stand-ins for tests: the HTTP client, and Google's sign-in on Vertex. */
export type ModelDeps = {
	fetch?: typeof fetch;
	googleAuthToken?: () => Promise<string | null>;
};

/** Claude on Foundry takes the Anthropic Messages API under /anthropic of the resource's address. */
const foundryBaseUrl = (resource: string) =>
	`https://${resource}.services.ai.azure.com/anthropic/v1`;

/**
 * The model of the provider in TEST_APP_AI. The only place the app creates one: a model named by a
 * plain string would go to Vercel's AI Gateway, which is not approved.
 */
export function aiModel(env: Env = process.env, deps: ModelDeps = {}) {
	const status = aiStatus(env);
	if (!aiReady(status)) {
		throw new Error(
			status.problem ??
				(status.provider === 'off'
					? 'The AI is off: set TEST_APP_AI to vertex or foundry.'
					: `The AI needs ${status.missing.join(' and ')}.`)
		);
	}
	const model = status.model ?? '';
	if (status.provider === 'vertex') {
		return createVertexAnthropic({
			project: env.GOOGLE_VERTEX_PROJECT?.trim(),
			location: env.GOOGLE_VERTEX_LOCATION?.trim(),
			fetch: deps.fetch,
			...(deps.googleAuthToken ? { generateAuthToken: deps.googleAuthToken } : {})
		})(model);
	}
	if (status.provider === 'anthropic') {
		// Local tests only: aiStatus refuses it with sign-in on or on the network.
		return createAnthropic({
			baseURL: 'https://api.anthropic.com/v1',
			apiKey: env.ANTHROPIC_API_KEY?.trim(),
			fetch: deps.fetch
		})(model);
	}
	// Both the address and the key are passed: without them the provider would fall back to
	// ANTHROPIC_API_KEY and api.anthropic.com, the direct API.
	return createAnthropic({
		baseURL: foundryBaseUrl(env.ANTHROPIC_FOUNDRY_RESOURCE?.trim() ?? ''),
		apiKey: env.ANTHROPIC_FOUNDRY_API_KEY?.trim(),
		fetch: deps.fetch
	})(model);
}
