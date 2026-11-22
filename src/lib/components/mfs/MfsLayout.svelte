<script lang="ts">
	import type { MfsSetup, MfsState } from '#lib/shared/mfs.js';
	import {
		between,
		CELL,
		huMarkers,
		occupiedBins,
		racks,
		rails,
		type Rack
	} from '#lib/shared/mfs-layout.js';

	let { setup, state }: { setup: MfsSetup; state: MfsState | undefined } = $props();

	const view = $derived(setup.view);
	const rackList = $derived(view ? racks(setup, view) : []);
	const railList = $derived(view ? rails(setup, view, state) : []);
	const markers = $derived(view ? huMarkers(setup, view, rackList, state) : []);
	const occupied = $derived(occupiedBins(rackList, state));
	const devices = $derived(new Map((state?.devices ?? []).map((device) => [device.id, device])));
	const conveyors = $derived(
		setup.devices.flatMap((device) => {
			const from = device.from && view?.points[device.from];
			const to = device.to && view?.points[device.to];
			return device.type === 'conveyor' && from && to
				? [{ id: device.id, ...between(from, to, 11) }]
				: [];
		})
	);
	const roles = $derived(new Map(setup.points.map((point) => [point.id, point.role])));
	const ROLE_TEXT: Record<string, string> = {
		gr: 'Goods receipt',
		'id-point': 'Identification point',
		clearing: 'Clearing',
		infeed: 'Infeed',
		outfeed: 'Outfeed',
		gi: 'Goods issue',
		'pick-point': 'Pick point'
	};

	const isDown = (id: string) => devices.get(id)?.status === 'DOWN';
	const isBusy = (id: string) => (devices.get(id)?.active ?? 0) > 0;
	const cells = (rack: Rack) =>
		Array.from({ length: rack.stacks * rack.levels }, (_, i) => {
			const stack = (i % rack.stacks) + 1;
			const level = Math.floor(i / rack.stacks) + 1;
			const bin = `${rack.aisle}-${String(stack).padStart(2, '0')}-${String(level).padStart(2, '0')}`;
			return { bin, x: rack.x + (stack - 1) * CELL, y: rack.y + (rack.levels - level) * CELL };
		});
</script>

{#if view}
	<svg
		viewBox="0 0 {view.width} {view.height}"
		role="img"
		aria-label="Layout of {setup.name}: racks, conveyors, transfer car and the HUs in them"
	>
		<defs>
			<marker
				id="arrow"
				viewBox="0 0 10 10"
				refX="9"
				refY="5"
				markerWidth="9"
				markerHeight="9"
				markerUnits="userSpaceOnUse"
				orient="auto"
			>
				<path d="M0,0 L10,5 L0,10 z" class="arrow" />
			</marker>
		</defs>

		{#each rackList as rack (rack.crane)}
			<text x={rack.x} y={rack.y - 10} class="label" class:down={isDown(rack.crane)}>
				Aisle {rack.aisle} · {rack.crane}{isDown(rack.crane)
					? ' · down'
					: isBusy(rack.crane)
						? ' · moving'
						: ''}
			</text>
			{#each cells(rack) as cell (cell.bin)}
				<rect
					x={cell.x}
					y={cell.y}
					width={CELL - 2}
					height={CELL - 2}
					class="bin"
					class:occupied={occupied.has(cell.bin)}
				>
					<title>
						{cell.bin}{occupied.has(cell.bin) ? `: HU ${occupied.get(cell.bin)}` : ': empty'}
					</title>
				</rect>
			{/each}
			{#each [rack.infeed, rack.outfeed] as point (point)}
				{#if point && view.points[point]}
					<line
						x1={view.points[point].x}
						y1={view.points[point].y}
						x2={view.points[point].x}
						y2={rack.y + rack.levels * CELL}
						class="track"
						class:down={isDown(rack.crane)}
					/>
				{/if}
			{/each}
		{/each}

		{#each railList as rail (rail.car)}
			<line
				x1={rail.x1}
				y1={rail.y}
				x2={rail.x2}
				y2={rail.y}
				class="rail"
				class:down={isDown(rail.car)}
			/>
			{#each rail.stops as stop (`${stop.x},${stop.y}`)}
				<line x1={stop.x} y1={stop.y} x2={stop.x} y2={rail.y} class="track" />
			{/each}
			<g
				transform="translate({rail.at ?? rail.x1}, {rail.y})"
				class="car"
				class:down={isDown(rail.car)}
				class:busy={rail.at !== undefined}
			>
				<rect x="-34" y="-11" width="68" height="22" rx="3" />
				<text y="4" text-anchor="middle">{rail.hu ? `${rail.car}: ${rail.hu}` : rail.car}</text>
			</g>
		{/each}

		{#each conveyors as conveyor (conveyor.id)}
			<line
				x1={conveyor.x1}
				y1={conveyor.y1}
				x2={conveyor.x2}
				y2={conveyor.y2}
				class="conveyor"
				class:down={isDown(conveyor.id)}
				marker-end="url(#arrow)"
			/>
		{/each}

		{#each Object.entries(view.points) as [id, point] (id)}
			<g transform="translate({point.x}, {point.y})">
				<circle r="7" class="point {roles.get(id) ?? ''}" />
				<text y="22" text-anchor="middle" class="label">{id}</text>
				<title>{ROLE_TEXT[roles.get(id) ?? ''] ?? id}</title>
			</g>
		{/each}

		{#each markers as marker (marker.hu)}
			<g transform="translate({marker.x}, {marker.y})" class="hu" class:moving={marker.moving}>
				<rect x="-30" y="-7" width="60" height="14" rx="7" />
				<text y="4" text-anchor="middle">{marker.hu}</text>
			</g>
		{/each}
	</svg>
{:else}
	<p class="muted">
		This setup has no drawing positions ("view" in its setup.json), so it is not drawn.
	</p>
{/if}

<style>
	svg {
		width: 100%;
		max-height: 32rem;
		display: block;
		font-family: var(--sapFontFamily);
	}
	.label {
		font-size: 11px;
		fill: var(--sapContent_LabelColor);
	}
	.label.down {
		fill: var(--sapNegativeColor);
		font-weight: bold;
	}
	.bin {
		fill: var(--sapList_Background);
		stroke: var(--sapList_BorderColor);
	}
	.bin.occupied {
		fill: var(--sapInformativeColor);
	}
	.track {
		stroke: var(--sapList_BorderColor);
		stroke-dasharray: 3 3;
	}
	.rail {
		stroke: var(--sapNeutralBorderColor);
		stroke-width: 4;
	}
	.conveyor {
		stroke: var(--sapNeutralBorderColor);
		stroke-width: 6;
		stroke-opacity: 0.6;
	}
	.down.rail,
	.down.conveyor,
	.down.track {
		stroke: var(--sapNegativeColor);
	}
	.arrow {
		fill: var(--sapNeutralBorderColor);
	}
	.car rect {
		fill: var(--sapButton_Background);
		stroke: var(--sapNeutralBorderColor);
	}
	.car.busy rect {
		stroke: var(--sapInformativeColor);
		stroke-width: 2;
	}
	.car.down rect {
		stroke: var(--sapNegativeColor);
		stroke-width: 2;
	}
	.car text {
		font-size: 10px;
		fill: var(--sapTextColor);
	}
	.point {
		fill: var(--sapBackgroundColor);
		stroke: var(--sapNeutralBorderColor);
		stroke-width: 2;
	}
	.point.id-point {
		stroke: var(--sapInformativeColor);
	}
	.point.clearing {
		stroke: var(--sapCriticalColor);
	}
	.point.gi,
	.point.gr {
		stroke: var(--sapPositiveColor);
	}
	.hu rect {
		fill: var(--sapInformativeColor);
	}
	.hu.moving rect {
		fill: var(--sapBackgroundColor);
		stroke: var(--sapInformativeColor);
		stroke-dasharray: 3 2;
	}
	.hu text {
		font-size: 10px;
		fill: var(--sapContent_ContrastTextColor, #fff);
	}
	.hu.moving text {
		fill: var(--sapTextColor);
	}
</style>
