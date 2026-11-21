<script lang="ts">
	import { errorMessage } from '#lib/client/run-actions.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';
	import { removeSetting, saveSetting } from '#lib/remote/settings.remote.js';
	import type { SettingName, SettingSource } from '#lib/shared/types.js';

	type Field = { name: SettingName; label: string; hint?: string; secret?: boolean };

	const GROUPS: { title: string; subtitle: string; fields: Field[] }[] = [
		{
			title: 'SAP system',
			subtitle: 'Fiori / UI5 and WebGUI',
			fields: [
				{ name: 'SAP_URL', label: 'URL', hint: 'https://your-test-system.example.com' },
				{ name: 'SAP_USERNAME', label: 'User', hint: 'Test user without MFA' },
				{ name: 'SAP_PASSWORD', label: 'Password', secret: true }
			]
		},
		{
			title: 'SAP Ariba',
			subtitle: 'Optional',
			fields: [
				{ name: 'ARIBA_URL', label: 'URL' },
				{ name: 'ARIBA_USER', label: 'User' },
				{ name: 'ARIBA_PASS', label: 'Password', secret: true }
			]
		},
		{
			title: 'Browser',
			subtitle: 'Optional',
			fields: [
				{
					name: 'CHROMIUM_PATH',
					label: 'Chromium path',
					hint: 'Only where playwright install cannot download'
				}
			]
		}
	];

	const SOURCE_LABEL: Record<SettingSource, string> = {
		keychain: 'Saved here',
		file: 'From .env',
		process: 'From environment'
	};

	const env = getEnvStatus();
	const drafts = $state<Partial<Record<SettingName, string>>>({});
	let busy = $state<SettingName | null>(null);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const sourceOf = (name: SettingName) => env.current?.vars.find((v) => v.name === name)?.source;

	async function change(name: SettingName, action: () => Promise<{ cleared: SettingName[] }>) {
		busy = name;
		error = null;
		notice = null;
		try {
			const { cleared } = await action();
			drafts[name] = '';
			if (cleared.length > 0) {
				notice = `The URL now points at another host, so the saved ${cleared.join(' and ')} were removed. Enter the credentials for the new system.`;
			}
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = null;
		}
	}

	const save = (name: SettingName) =>
		change(name, () => saveSetting({ name, value: drafts[name] ?? '' }));
	const remove = (name: SettingName) => change(name, () => removeSetting(name));
</script>

<div class="page-head">
	<ui5-title level="H2">Settings</ui5-title>
</div>

<ui5-message-strip design="Information" hide-close-button>
	Values saved here go into this computer's credential store (Keychain on macOS, Credential Manager
	on Windows, the keyring on Linux), not into a file in the project. They are used for runs and
	recordings started from this app and are never shown again. A value saved here wins over
	<span class="mono">sap-tests/.env</span>.
</ui5-message-strip>

{#if env.current && !env.current.keychain}
	<ui5-message-strip design="Critical" hide-close-button>
		No credential store is available on this machine, so nothing can be saved here. Put the values
		in <span class="mono">sap-tests/.env</span> instead.
	</ui5-message-strip>
{/if}
{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}
{#if notice}
	<ui5-message-strip design="Critical" onclose={() => (notice = null)}>{notice}</ui5-message-strip>
{/if}

{#if env.current}
	{@const locked = !env.current.keychain}
	<div class="groups">
		{#each GROUPS as group (group.title)}
			<ui5-card>
				<ui5-card-header slot="header" title-text={group.title} subtitle-text={group.subtitle}
				></ui5-card-header>
				<div class="card-body">
					{#each group.fields as field (field.name)}
						{@const source = sourceOf(field.name)}
						{@const draft = drafts[field.name] ?? ''}
						<div class="field" data-setting={field.name}>
							<div class="what">
								<ui5-label for={field.name}>{field.label}</ui5-label>
								<span class="muted mono">{field.name}</span>
							</div>
							<ui5-input
								id={field.name}
								type={field.secret ? 'Password' : 'Text'}
								value={draft}
								placeholder={source ? 'Enter a new value to replace it' : (field.hint ?? '')}
								disabled={locked || undefined}
								oninput={(e: Event) => (drafts[field.name] = (e.target as HTMLInputElement).value)}
								onkeydown={(e: KeyboardEvent) => {
									if (e.key === 'Enter' && draft && busy === null) void save(field.name);
								}}
							></ui5-input>
							<ui5-tag design={source ? 'Positive' : 'Neutral'} hide-state-icon>
								{source ? SOURCE_LABEL[source] : 'Not set'}
							</ui5-tag>
							<div class="row">
								<ui5-button
									design="Emphasized"
									disabled={locked || !draft || busy !== null || undefined}
									onclick={() => save(field.name)}
								>
									Save
								</ui5-button>
								<ui5-button
									design="Transparent"
									disabled={source !== 'keychain' || busy !== null || undefined}
									onclick={() => remove(field.name)}
								>
									Remove
								</ui5-button>
							</div>
						</div>
					{/each}
				</div>
			</ui5-card>
		{/each}
	</div>
{:else}
	<ui5-busy-indicator active size="L" class="page-busy"></ui5-busy-indicator>
{/if}

<style>
	.groups {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 60rem;
	}
	.field {
		display: grid;
		grid-template-columns: 11rem minmax(12rem, 1fr) 9rem auto;
		gap: 0.75rem;
		align-items: center;
	}
	.field ui5-input {
		width: 100%;
	}
	/* A tag that fills its grid cell looks like a button. */
	.field ui5-tag {
		justify-self: start;
	}
	.what {
		display: flex;
		flex-direction: column;
	}
	.what .mono {
		font-size: 0.75rem;
	}
	@media (max-width: 800px) {
		.field {
			grid-template-columns: 1fr;
			gap: 0.25rem;
			padding-bottom: 0.75rem;
		}
	}
</style>
