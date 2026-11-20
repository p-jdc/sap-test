<script lang="ts">
	import '#lib/ui5.js';
	import '../app.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const NAV = [
		{ href: '/', text: 'Dashboard', icon: 'home' },
		{ href: '/tests', text: 'Tests & Flows', icon: 'process' },
		{ href: '/runs', text: 'Runs', icon: 'history' },
		{ href: '/recorder', text: 'Recorder', icon: 'record' },
		{ href: '/checklist', text: 'Checklist', icon: 'checklist' }
	];

	let collapsed = $state(false);
	const current = $derived(
		NAV.slice()
			.reverse()
			.find((n) =>
				n.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(n.href)
			)?.href ?? (page.url.pathname.startsWith('/flow') ? '/tests' : '/')
	);

	function onSelect(e: CustomEvent) {
		const href = (e.detail.item as HTMLElement).dataset.href;
		if (href && href !== page.url.pathname) goto(href);
	}
</script>

<svelte:head>
	<title>SAP Test Lab</title>
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
