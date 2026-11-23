import { authMode, listensLocally } from '../auth/policy.js';
import type { AiProvider, AiStatus } from '#lib/shared/types.js';

/** The model when TEST_APP_AI_MODEL is unset. On Foundry the model is the deployment's name. */
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

const PROVIDERS: readonly AiProvider[] = ['vertex', 'foundry', 'anthropic'];

/** The settings each provider needs. Sign-in to Vertex comes from Google's own credentials. */
const NEEDS: Record<AiProvider, string[]> = {
	vertex: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
	foundry: ['ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY'],
	anthropic: ['ANTHROPIC_API_KEY']
};

/** Model ids and Foundry deployment names: letters, digits and `.-_@` (Vertex dates older models with `@`). */
const MODEL = /^[\w.@-]{1,100}$/;
/** An Azure resource name: the first label of <resource>.services.ai.azure.com. */
const RESOURCE = /^[a-z\d][a-z\d-]{0,62}$/i;

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => env[name]?.trim() || undefined;

function isProvider(name: string): name is AiProvider {
	return PROVIDERS.some((p) => p === name);
}

/**
 * Whether the app is a local one: sign-in off, and listening on this computer only. The direct
 * Anthropic API is for local tests with the demo tests; the company's data goes through Vertex or
 * Foundry, and an app others reach (the cluster) always has sign-in on or another HOST.
 */
function localOnly(env: Env) {
	try {
		return authMode(env.TEST_APP_AUTH) === 'off' && listensLocally(env.HOST);
	} catch {
		return false;
	}
}

/** How the app reaches the AI. Off unless TEST_APP_AI names a provider. */
export function aiStatus(env: Env = process.env): AiStatus {
	const chosen = value(env, 'TEST_APP_AI') ?? 'off';
	if (chosen === 'off') return { provider: 'off', missing: [] };
	if (!isProvider(chosen)) {
		return {
			provider: 'off',
			missing: [],
			problem: `TEST_APP_AI must be off, vertex or foundry (or anthropic for local tests). The AI is used only through the company's Vertex AI or Microsoft Foundry.`
		};
	}
	const model = value(env, 'TEST_APP_AI_MODEL') ?? DEFAULT_AI_MODEL;
	const missing = NEEDS[chosen].filter((name) => !value(env, name));
	const status: AiStatus = { provider: chosen, model, missing };
	if (!MODEL.test(model)) {
		status.problem = 'TEST_APP_AI_MODEL may only contain letters, digits and . - _ @.';
	}
	if (chosen === 'vertex') {
		const project = value(env, 'GOOGLE_VERTEX_PROJECT');
		const location = value(env, 'GOOGLE_VERTEX_LOCATION');
		status.where = `Vertex AI, project ${project ?? '?'}, location ${location ?? '?'}`;
	} else if (chosen === 'foundry') {
		const resource = value(env, 'ANTHROPIC_FOUNDRY_RESOURCE');
		if (resource && !RESOURCE.test(resource)) {
			status.problem =
				'ANTHROPIC_FOUNDRY_RESOURCE must be the name of the Foundry resource (letters, digits and hyphens), not its address.';
		}
		status.where = `Microsoft Foundry, resource ${resource ?? '?'}`;
	} else {
		status.where = 'Anthropic API, for local tests only';
		if (!localOnly(env)) {
			status.problem =
				'TEST_APP_AI=anthropic is for local tests only: not with sign-in on or with HOST on the network. Use vertex or foundry there.';
		}
	}
	return status;
}
