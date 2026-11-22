<script lang="ts">
	import { errorMessage } from '#lib/client/run-actions.js';
	import { view } from '#lib/client/view.svelte.js';
	import People from '#lib/components/People.svelte';
	import { getMe } from '#lib/remote/people.remote.js';
	import { getEnvStatus } from '#lib/remote/specs.remote.js';
	import { removeSetting, saveSetting } from '#lib/remote/settings.remote.js';
	import type { SettingName, SettingSource, SignInSystemInfo } from '#lib/shared/types.js';

	type Field = { name: SettingName; label: string; hint?: string; secret?: boolean };
	/** `technical` groups only show with "Technical details" switched on. */
	type Group = { title: string; subtitle: string; technical?: boolean; fields: Field[] };

	/** One group per system of sap-tests/systems.json, then the settings of no system. */
	const systemGroup = (system: SignInSystemInfo): Group => ({
		title: system.title,
		subtitle: system.description ?? '',
		fields: [
			{ name: system.env.url, label: 'Web address', hint: 'https://your-test-system.example.com' },
			{
				name: system.env.user,
				label: 'User name',
				hint: 'A test user that logs in with just a password'
			},
			{ name: system.env.password, label: 'Password', secret: true }
		]
	});

	const OTHER_GROUPS: Group[] = [
		{
			title: 'SAP services (API)',
			subtitle:
				'Optional: only for tests that call SAP services directly. They create and change data, so use a development system',
			fields: [
				{
					name: 'SAP_API_URL',
					label: 'Web address',
					hint: 'https://your-dev-system.example.com (no path)'
				},
				{ name: 'SAP_API_USERNAME', label: 'User name' },
				{ name: 'SAP_API_PASSWORD', label: 'Password', secret: true },
				{ name: 'SAP_CLIENT', label: 'Client', hint: 'Three digits, for example 100' }
			]
		},
		{
			title: 'Browser',
			subtitle: 'Optional',
			technical: true,
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
	/** Without technical details, where a value comes from matters only if it can be removed here. */
	const sourceLabel = (source: SettingSource) =>
		view.technical ? SOURCE_LABEL[source] : source === 'keychain' ? 'Saved' : 'Set by your admin';

	const env = getEnvStatus();
	const me = getMe();
	// With sign-in on, only admins change settings (the server checks this too).
	const admin = $derived(!me.current?.auth || me.current.user?.role === 'admin');
	const groups = $derived([
		...(env.current?.systems ?? []).map((s) => systemGroup(s)),
		...OTHER_GROUPS
	]);
	const drafts = $state<Partial<Record<SettingName, string>>>({});
	let busy = $state<SettingName | null>(null);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const sourceOf = (name: SettingName) => env.current?.vars.find((v) => v.name === name)?.source;
	const withheldOf = (name: SettingName) =>
		env.current?.vars.find((v) => v.name === name)?.withheld;

	async function change(name: SettingName, action: () => Promise<{ cleared: SettingName[] }>) {
		busy = name;
		error = null;
		notice = null;
		try {
			const { cleared } = await action();
			drafts[name] = '';
			if (cleared.length > 0) {
				notice = view.technical
					? `The URL now points at another host, so the saved ${cleared.join(' and ')} were removed. Enter the credentials for the new system.`
					: 'The address now points at a different system, so the saved user name and password were removed. Enter them again for the new system.';
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
	{#if view.technical}
		Values saved here go into this computer's credential store (Keychain on macOS, Credential
		Manager on Windows, the keyring on Linux), not into a file in the project. They are used for
		runs and recordings started from this app and are never shown again. A value saved here wins
		over
		<span class="mono">sap-tests/.env</span>.
	{:else}
		Tell the app where your SAP test system is and which user it should log in with. Everything is
		kept in this computer's password store and is never shown again, not even here. Use a test
		system and a test user, never your personal login.
	{/if}
</ui5-message-strip>

{#if env.current?.systemsError}
	<ui5-message-strip design="Negative" hide-close-button>
		The list of systems the tests sign in to cannot be read, so no test can run until it is fixed.
		<span class="mono">{env.current.systemsError}</span>
	</ui5-message-strip>
{/if}

{#if env.current && !env.current.keychain}
	<ui5-message-strip design="Critical" hide-close-button>
		{#if view.technical}
			No credential store is available on this machine, so nothing can be saved here. Put the values
			in <span class="mono">sap-tests/.env</span> instead.
		{:else}
			This computer has no password store, so nothing can be saved here. Ask the person who
			installed this app to enter the connection for you.
		{/if}
	</ui5-message-strip>
{/if}
{#if error}
	<ui5-message-strip design="Negative" onclose={() => (error = null)}>{error}</ui5-message-strip>
{/if}
{#if notice}
	<ui5-message-strip design="Critical" onclose={() => (notice = null)}>{notice}</ui5-message-strip>
{/if}

{#if me.current && !admin}
	<ui5-message-strip design="Information" hide-close-button>
		Only an admin can change these settings.
	</ui5-message-strip>
{/if}

{#if env.current}
	{@const locked = !env.current.keychain || !admin}
	<div class="groups">
		{#each groups.filter((g) => view.technical || !g.technical) as group (group.title)}
			<ui5-card>
				<ui5-card-header slot="header" title-text={group.title} subtitle-text={group.subtitle}
				></ui5-card-header>
				<div class="card-body">
					{#each group.fields as field (field.name)}
						{@const source = sourceOf(field.name)}
						{@const withheld = withheldOf(field.name)}
						{@const draft = drafts[field.name] ?? ''}
						<div class="field" data-setting={field.name}>
							<div class="what">
								<ui5-label for={field.name}>{field.label}</ui5-label>
								{#if view.technical}<span class="muted mono">{field.name}</span>{/if}
							</div>
							<ui5-input
								id={field.name}
								type={field.secret ? 'Password' : 'Text'}
								value={draft}
								placeholder={source ? 'Already set. Type here to replace it' : (field.hint ?? '')}
								disabled={locked || undefined}
								oninput={(e: Event) => (drafts[field.name] = (e.target as HTMLInputElement).value)}
								onkeydown={(e: KeyboardEvent) => {
									if (e.key === 'Enter' && draft && busy === null) void save(field.name);
								}}
							></ui5-input>
							<ui5-tag
								design={source ? 'Positive' : withheld ? 'Critical' : 'Neutral'}
								hide-state-icon
							>
								{source ? sourceLabel(source) : withheld ? 'Not used' : 'Not set'}
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
							{#if withheld && !source}
								<p class="withheld">
									{#if withheld === 'keychain'}
										This was saved for a different address than the one this system has now, so it
										is not used. Enter it again for this address.
									{:else if view.technical}
										{field.name} is set {withheld === 'file'
											? 'in sap-tests/.env'
											: 'in the environment'}, but not used: it belongs to the URL set there, and
										the URL saved here points at another host. Save it here for this host.
									{:else}
										Your admin set this for a different address than the one saved here, so it is
										not used. Enter it here for this address.
									{/if}
								</p>
							{/if}
						</div>
					{/each}
				</div>
			</ui5-card>
		{/each}
		{#if me.current?.auth && admin}
			<People />
		{/if}
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
	.field .withheld {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--sapCriticalTextColor);
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
