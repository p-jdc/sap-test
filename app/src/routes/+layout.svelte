<script lang="ts">
	import '#lib/ui5.js';
	import '../app.css';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const NAV = [
		{ href: '/', link: resolve('/'), text: 'Dashboard', icon: 'home' },
		{ href: '/tests', link: resolve('/tests'), text: 'Tests & Flows', icon: 'process' },
		{ href: '/runs', link: resolve('/runs'), text: 'Runs', icon: 'history' },
		{ href: '/recorder', link: resolve('/recorder'), text: 'Recorder', icon: 'record' },
		{ href: '/checklist', link: resolve('/checklist'), text: 'Checklist', icon: 'checklist' },
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
	<title>{NAV.find((n) => n.href === current)?.text ?? 'Dashboard'} · SAP Test Lab</title>
</svelte:head>

<div class="shell">
	<ui5-shellbar primary-title="SAP Test Lab" secondary-title="Playwright-SAP runner & flow viewer">
		<ui5-button
			icon="menu2"
			slot="startButton"
			onclick={() => (collapsed = !collapsed)}
			tooltip="Toggle navigation"
		></ui5-button>
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
