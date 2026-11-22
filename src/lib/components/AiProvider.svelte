<script lang="ts">
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import { checkAiConnection, getAiStatus } from '#lib/remote/ai.remote.js';
	import { aiReady } from '#lib/shared/ai.js';
	import type { AiCheck } from '#lib/shared/types.js';

	let { admin }: { admin: boolean } = $props();

	const status = getAiStatus();
	const ready = $derived(status.current !== undefined && aiReady(status.current));

	let checking = $state(false);
	let result = $state<AiCheck | null>(null);

	async function check() {
		checking = true;
		result = null;
		try {
			result = await checkAiConnection();
		} catch (e) {
			result = { ok: false, error: errorMessage(e) };
		} finally {
			checking = false;
		}
	}

	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
</script>

<ui5-card>
	<ui5-card-header
		slot="header"
		title-text="AI provider"
		subtitle-text={status.current?.where ?? 'Off'}
	></ui5-card-header>
	<div class="card-body ai">
		{#if status.current}
			{@const current = status.current}
			{#if current.problem}
				<ui5-message-strip design="Negative" hide-close-button>{current.problem}</ui5-message-strip>
			{/if}
			{#if current.provider === 'off'}
				<p>
					The AI features are off. They work only through the company's Vertex AI or Microsoft
					Foundry{#if view.technical}: set <span class="mono">TEST_APP_AI</span> to
						<span class="mono">vertex</span>
						or <span class="mono">foundry</span>{:else}; your admin can switch them on{/if}.
				</p>
			{:else}
				<p>Model: <span class="mono">{current.model}</span></p>
				{#if current.provider === 'anthropic'}
					<ui5-message-strip design="Information" hide-close-button>
						For local tests with the demo tests only. With the company's systems, the AI goes
						through Vertex AI or Microsoft Foundry.
					</ui5-message-strip>
				{/if}
				{#if current.missing.length > 0}
					<ui5-message-strip design="Critical" hide-close-button>
						Still needed: <span class="mono">{current.missing.join(', ')}</span>
					</ui5-message-strip>
				{/if}
				{#if admin}
					<div class="row">
						<ui5-button design="Default" disabled={!ready || checking || undefined} onclick={check}>
							Check connection
						</ui5-button>
						<span class="muted">
							Sends one short test message, nothing from a test or a system.
						</span>
					</div>
				{/if}
				{#if result?.ok}
					<ui5-message-strip design="Positive" hide-close-button>
						{result.model} answered "{result.reply}" in {seconds(result.ms)}{#if view.technical}
							({result.inputTokens ?? '?'} tokens in, {result.outputTokens ?? '?'} out){/if}.
					</ui5-message-strip>
				{:else if result}
					<ui5-message-strip design="Negative" hide-close-button>
						No answer: {result.error}
					</ui5-message-strip>
				{/if}
			{/if}
		{:else}
			<ui5-busy-indicator active size="S"></ui5-busy-indicator>
		{/if}
	</div>
</ui5-card>

<style>
	.ai p {
		margin: 0;
	}
	.ai .row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
</style>
