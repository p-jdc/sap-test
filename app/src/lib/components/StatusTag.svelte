<script lang="ts">
	import { statusDesign } from '#lib/shared/format.js';

	let { status, label }: { status: string | undefined; label?: string } = $props();
</script>

<ui5-tag
	design={statusDesign(status as never)}
	hide-state-icon={statusDesign(status as never) === 'Neutral' || status === 'running' || undefined}
>
	{label ?? status ?? 'not run'}
</ui5-tag>
