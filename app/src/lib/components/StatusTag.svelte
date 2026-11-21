<script lang="ts">
	import { statusDesign, statusLabel } from '#lib/shared/format.js';

	let { status, label }: { status: string | undefined; label?: string } = $props();
</script>

<ui5-tag
	design={statusDesign(status)}
	hide-state-icon={statusDesign(status) === 'Neutral' || status === 'running' || undefined}
>
	{label ?? statusLabel(status)}
</ui5-tag>
