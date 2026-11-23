import { generateText } from 'ai';
import { redactor } from '../redact.js';
import type { AiCheck } from '#lib/shared/types.js';
import { aiModel, type ModelDeps } from './model.js';
import { aiStatus } from './settings.js';

type Env = Record<string, string | undefined>;

const PROMPT = 'This is a connection test. Answer with the single word OK.';

/**
 * Sends one short request to the configured provider, so whoever holds the credentials can see
 * that they work. Nothing from a test or an SAP system goes into it.
 */
export async function checkAi(env: Env = process.env, deps: ModelDeps = {}): Promise<AiCheck> {
	const hide = redactor(
		[env.ANTHROPIC_FOUNDRY_API_KEY, env.ANTHROPIC_API_KEY].map((key) => key?.trim() ?? '')
	);
	const started = performance.now();
	try {
		const result = await generateText({
			model: aiModel(env, deps),
			prompt: PROMPT,
			// Thinking stays on with Claude Opus 5.5 and counts here; this leaves it room.
			maxOutputTokens: 2000,
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(60_000)
		});
		const check: AiCheck = {
			ok: true,
			reply: result.text.trim().slice(0, 200),
			model: result.finalStep.response.modelId,
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
			ms: Math.round(performance.now() - started)
		};
		const { provider } = aiStatus(env);
		console.log(
			`AI check: ${provider}, ${check.model}, ${check.ms} ms, ${check.inputTokens ?? '?'} tokens in, ${check.outputTokens ?? '?'} out`
		);
		return check;
	} catch (e) {
		return { ok: false, error: hide(e instanceof Error ? e.message : String(e)) };
	}
}
