import type { AiStatus } from './types.js';

/** Whether the AI can be called: a provider is chosen and nothing is missing or wrong. */
export const aiReady = (status: AiStatus) =>
	status.provider !== 'off' && status.missing.length === 0 && !status.problem;
