<script lang="ts">
	import { isIP } from '#lib/client/address.js';
	import { authClient } from '#lib/client/auth.js';
	import { page } from '$app/state';

	type State =
		| { on: false }
		| { on: true; signedIn: boolean; needsSetup: boolean; setup: boolean; invite: string | null };

	const setup = page.url.searchParams.get('setup');
	const invite = page.url.searchParams.get('invite');
	// Only a path on this app (the server checks the same before redirecting here).
	const back = (() => {
		const r = page.url.searchParams.get('redirect') ?? '/';
		return r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/';
	})();

	let info = $state<State | null>(null);
	let name = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	// A passkey belongs to a host name, so the app must be opened by name, not by address.
	const byAddress = isIP(page.url.hostname);
	const byName = `${page.url.protocol}//localhost${page.url.port ? ':' + page.url.port : ''}${page.url.pathname}${page.url.search}`;

	async function load() {
		const params = [
			invite ? `invite=${encodeURIComponent(invite)}` : '',
			setup ? `setup=${encodeURIComponent(setup)}` : ''
		].filter(Boolean);
		const response = await fetch(
			`/api/signin-state${params.length > 0 ? `?${params.join('&')}` : ''}`
		);
		const loaded = (await response.json()) as State;
		info = loaded;
		if (!loaded.on || loaded.signedIn) location.replace(back);
	}
	$effect(() => {
		void load();
	});

	const done = () => location.replace(back);

	async function attempt(
		action: () => Promise<{ error?: { message?: string } | null } | undefined>
	) {
		busy = true;
		error = null;
		try {
			const result = await action();
			if (result?.error) error = result.error.message ?? 'That did not work.';
			else done();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	const signInWithPasskey = () => attempt(() => authClient.signIn.passkey());

	const register = (context: object) =>
		attempt(() =>
			authClient.passkey.addPasskey({
				name: 'SAP Test Lab',
				context: JSON.stringify(context),
				createSession: true
			})
		);
</script>

<div class="signin">
	<ui5-card>
		<ui5-card-header slot="header" title-text="Sign in" subtitle-text="SAP Test Lab"
		></ui5-card-header>
		<div class="card-body">
			{#if byAddress}
				<ui5-message-strip design="Critical" hide-close-button>
					A passkey belongs to a name, not an address, so open the app as localhost.
				</ui5-message-strip>
				<ui5-button design="Emphasized" onclick={() => location.replace(byName)}>
					Open as localhost
				</ui5-button>
			{:else if !info}
				<ui5-busy-indicator active size="M"></ui5-busy-indicator>
			{:else if info.on}
				{#if error}
					<ui5-message-strip design="Negative" onclose={() => (error = null)}>
						{error}
					</ui5-message-strip>
				{/if}
				{#if setup && info.setup}
					<p>Nobody is registered yet. Create the first account: it becomes the admin.</p>
					<ui5-label for="name" show-colon>Your name</ui5-label>
					<ui5-input
						id="name"
						value={name}
						oninput={(e: Event) => (name = (e.target as HTMLInputElement).value)}
					></ui5-input>
					<ui5-button
						design="Emphasized"
						icon="key"
						disabled={busy || !name.trim() || undefined}
						onclick={() => register({ setup, name })}
					>
						Create a passkey
					</ui5-button>
				{:else if invite && info.invite}
					<p>Welcome, {info.invite}. Create a passkey to sign in to SAP Test Lab.</p>
					<ui5-button
						design="Emphasized"
						icon="key"
						disabled={busy || undefined}
						onclick={() => register({ invite })}
					>
						Create a passkey
					</ui5-button>
				{:else}
					{#if invite}
						<ui5-message-strip design="Critical" hide-close-button>
							This invite link is not valid any more. Ask an admin for a new one.
						</ui5-message-strip>
					{/if}
					{#if info.needsSetup}
						<p>
							Nobody is registered yet. The server's log shows a link to create the first account.
						</p>
					{:else}
						<ui5-button
							design="Emphasized"
							icon="key"
							disabled={busy || undefined}
							onclick={signInWithPasskey}
						>
							Sign in with a passkey
						</ui5-button>
						<p class="muted">No passkey yet? Ask an admin for an invite link.</p>
					{/if}
				{/if}
			{/if}
		</div>
	</ui5-card>
</div>

<style>
	.signin {
		display: grid;
		place-items: center;
		min-height: 80vh;
		padding: 1rem;
	}
	.signin ui5-card {
		width: min(28rem, 100%);
	}
	p {
		margin: 0;
	}
</style>
