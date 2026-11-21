<script lang="ts">
	import '#lib/ui5.js';
	import '../app.css';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { setShowBrowser, setTechnical, view } from '#lib/client/view.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const NAV = [
		{ href: '/', link: resolve('/'), text: 'Home', icon: 'home' },
		{ href: '/tests', link: resolve('/tests'), text: 'Tests', icon: 'process' },
		{ href: '/runs', link: resolve('/runs'), text: 'Results', icon: 'history' },
		{ href: '/recorder', link: resolve('/recorder'), text: 'Record a test', icon: 'record' },
		{ href: '/mfs', link: resolve('/mfs'), text: 'Mock PLC', icon: 'machine' },
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

	function onSelect(e: CustomEvent<{ item: HTMLElement }>) {
		const item = NAV.find((n) => n.href === e.detail.item.dataset.href);
		if (item && item.link !== page.url.pathname) void goto(item.link);
	}
</script>

<svelte:head>
	<title>{NAV.find((n) => n.href === current)?.text ?? 'Home'} · SAP Test Lab</title>
</svelte:head>

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
		</ui5-side-navigation>
		<main>
			{@render children()}
		</main>
	</div>
</div>

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
