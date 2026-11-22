<script lang="ts">
	import '#lib/ui5.js';
	import '../app.css';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { authClient } from '#lib/client/auth.js';
	import { setShowBrowser, setTechnical, view } from '#lib/client/view.svelte.js';
	import { getMe } from '#lib/remote/people.remote.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const NAV = [
		{ href: '/', link: resolve('/'), text: 'Home', icon: 'home' },
		{ href: '/tests', link: resolve('/tests'), text: 'Tests', icon: 'process' },
		{ href: '/runs', link: resolve('/runs'), text: 'Results', icon: 'history' },
		{ href: '/recorder', link: resolve('/recorder'), text: 'Record a test', icon: 'record' },
		{ href: '/mfs', link: resolve('/mfs'), text: 'Mock PLC', icon: 'machine' },
		{ href: '/idoc', link: resolve('/idoc'), text: 'Mock IDoc', icon: 'inbox' },
		{ href: '/settings', link: resolve('/settings'), text: 'Settings', icon: 'action-settings' }
	];

	// The navigation starts as an icon rail where it would otherwise take most of the window, and
	// follows the window across that width until the user toggles it.
	const narrow = matchMedia('(max-width: 900px)');
	let collapsed = $state(narrow.matches);
	$effect(() => {
		const onChange = () => (collapsed = narrow.matches);
		narrow.addEventListener('change', onChange);
		return () => narrow.removeEventListener('change', onChange);
	});

	const current = $derived(
		NAV.toReversed().find((n) =>
			n.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(n.href)
		)?.href ?? (page.url.pathname.startsWith('/flow') ? '/tests' : '/')
	);

	// The sign-in page stands alone; elsewhere the signed-in person (sign-in on) is at the foot of
	// the navigation, which signs them out.
	const signInPage = $derived(page.url.pathname === '/signin');
	// Created once, like every page's queries. On the sign-in page it answers 401, which is ignored.
	const meQuery = getMe();
	const me = $derived(signInPage ? null : meQuery.current);

	// A session that ended (expired, or removed by an admin) answers 401: sign in again and return.
	window.fetch = new Proxy(window.fetch, {
		apply: async (target, thisArg, args: Parameters<typeof fetch>) => {
			// oxlint-disable-next-line anti-slop/no-reflect-apply -- an apply trap passes the call on as it came
			const response = await Reflect.apply(target, thisArg, args);
			if (response.status === 401 && location.pathname !== '/signin')
				location.replace(
					`/signin?redirect=${encodeURIComponent(location.pathname + location.search)}`
				);
			return response;
		}
	});

	async function signOut() {
		await authClient.signOut();
		location.replace('/signin');
	}

	function onSelect(e: CustomEvent<{ item: HTMLElement }>) {
		if (e.detail.item.dataset.action === 'sign-out') return void signOut();
		const item = NAV.find((n) => n.href === e.detail.item.dataset.href);
		if (item && item.link !== page.url.pathname) void goto(item.link);
	}
</script>

<svelte:head>
	<title>{NAV.find((n) => n.href === current)?.text ?? 'Home'} · SAP Test Lab</title>
</svelte:head>

{#if signInPage}
	{@render children()}
{:else}
	<div class="shell">
		<ui5-shellbar primary-title="SAP Test Lab" secondary-title="Run and check SAP tests">
			<ui5-button
				icon="menu2"
				slot="startButton"
				onclick={() => (collapsed = !collapsed)}
				tooltip="Show or hide the menu"
			></ui5-button>
			<ui5-shellbar-spacer slot="content"></ui5-shellbar-spacer>
			<div
				slot="content"
				class="bar-switch"
				title="Open a browser window when a test runs, so you can watch it"
			>
				<ui5-label for="show-browser">Show browser</ui5-label>
				<ui5-switch
					id="show-browser"
					accessible-name="Show browser"
					checked={view.showBrowser || undefined}
					onchange={(e: Event) => setShowBrowser((e.target as HTMLInputElement).checked)}
				></ui5-switch>
			</div>
			<div slot="content" class="bar-switch" title="Also show file names, code and logs">
				<ui5-label for="technical">Technical details</ui5-label>
				<ui5-switch
					id="technical"
					accessible-name="Technical details"
					checked={view.technical || undefined}
					onchange={(e: Event) => setTechnical((e.target as HTMLInputElement).checked)}
				></ui5-switch>
			</div>
		</ui5-shellbar>
		<div class="body">
			<ui5-side-navigation {collapsed} onselection-change={onSelect}>
				{#each NAV as item (item.href)}
					<ui5-side-navigation-item
						text={item.text}
						icon={item.icon}
						data-href={item.href}
						selected={current === item.href || undefined}
					></ui5-side-navigation-item>
				{/each}
				{#if me?.user}
					<ui5-side-navigation-item
						slot="fixedItems"
						icon="log"
						data-action="sign-out"
						text={`Sign out: ${me.user.name}${me.user.role === 'admin' ? ' (admin)' : ''}`}
					></ui5-side-navigation-item>
				{/if}
			</ui5-side-navigation>
			<main>
				{@render children()}
			</main>
		</div>
	</div>
{/if}

<style>
	.bar-switch {
		margin-left: 1rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		white-space: nowrap;
	}
	.bar-switch ui5-label {
		color: var(--sapShell_TextColor);
	}
</style>
