import { describe, expect, test } from 'vitest';
import type { MfsSetup, MfsState } from './mfs.js';
import { binCell, CELL, huMarkers, occupiedBins, positionOf, racks, rails } from './mfs-layout.js';

const setup: MfsSetup = {
	name: 'test',
	description: '',
	interfaceType: 'DEMO',
	ewm: 'EWM1',
	plcs: [{ id: 'CONS', description: '' }],
	points: [
		{ id: 'IP', role: 'id-point' },
		{ id: 'A1-IN', role: 'infeed' },
		{ id: 'GI', role: 'gi' }
	],
	devices: [
		{ id: 'TCAR', type: 'transfer-car', plc: 'CONS', stops: ['IP', 'A1-IN', 'GI'] },
		{
			id: 'SRM1',
			type: 'stacker-crane',
			plc: 'CONS',
			aisle: 'A1',
			infeed: 'A1-IN',
			stacks: 10,
			levels: 5
		}
	],
	view: {
		width: 500,
		height: 300,
		points: { IP: { x: 100, y: 250 }, 'A1-IN': { x: 300, y: 150 }, GI: { x: 400, y: 250 } },
		racks: { SRM1: { x: 50, y: 20 } },
		rails: { TCAR: { y: 200 } }
	}
};
const view = setup.view ?? { width: 0, height: 0, points: {}, racks: {} };
const rackList = racks(setup, view);

const hu = (id: string, extra: Partial<MfsState['hus'][number]>): MfsState['hus'][number] => ({
	hu: id,
	left: false,
	script: {},
	path: [],
	...extra
});
const state = (hus: MfsState['hus']): MfsState => ({ setup: 'test', plcs: [], devices: [], hus });

describe('Mock PLC layout geometry', () => {
	test('bins are cells of their aisle rack, level 1 at the bottom', () => {
		expect(binCell(rackList, 'A1-01-01')).toMatchObject({ x: 50, y: 20 + 4 * CELL });
		expect(binCell(rackList, 'A1-10-05')).toMatchObject({ x: 50 + 9 * CELL, y: 20 });
		expect(binCell(rackList, 'A1-11-01')).toBeUndefined();
		expect(binCell(rackList, 'A2-01-01')).toBeUndefined();
		expect(positionOf(view, rackList, 'GI')).toEqual({ x: 400, y: 250 });
		expect(positionOf(view, rackList, 'A1-01-01')).toEqual({
			x: 50 + CELL / 2,
			y: 20 + 4.5 * CELL
		});
	});

	test('the transfer car rail spans its stops; the car is drawn halfway while it carries an HU', () => {
		expect(rails(setup, view)).toEqual([
			expect.objectContaining({ car: 'TCAR', y: 200, x1: 100, x2: 400, at: undefined })
		]);
		const moving = state([hu('H1', { moving: { device: 'TCAR', src: 'IP', dst: 'GI' } })]);
		expect(rails(setup, view, moving)[0]?.at).toBe(250);
	});

	test('HUs at a point are stacked above it, moving HUs sit between source and destination, stored ones fill their bin', () => {
		const current = state([
			hu('H1', { at: 'IP' }),
			hu('H2', { at: 'IP' }),
			hu('H3', { moving: { device: 'SRM1', src: 'A1-IN', dst: 'A1-01-01' } }),
			hu('H4', { at: 'A1-02-03' }),
			hu('H5', { at: 'GI', left: true })
		]);
		expect(huMarkers(setup, view, rackList, current)).toEqual([
			{ hu: 'H1', x: 100, y: 232, moving: false },
			{ hu: 'H2', x: 100, y: 216, moving: false },
			{ hu: 'H3', x: (300 + 50 + CELL / 2) / 2, y: (150 + 20 + 4.5 * CELL) / 2, moving: true }
		]);
		expect([...occupiedBins(rackList, current)]).toEqual([['A1-02-03', 'H4']]);
	});

	test('an HU on the transfer car is shown on the car, not as its own marker', () => {
		const current = state([hu('H1', { moving: { device: 'TCAR', src: 'IP', dst: 'GI' } })]);
		expect(huMarkers(setup, view, rackList, current)).toEqual([]);
		expect(rails(setup, view, current)[0]).toMatchObject({ at: 250, hu: 'H1' });
	});
});
