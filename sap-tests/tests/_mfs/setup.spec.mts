// KI-generiert, geprüft von: <Name>
// Mock setups of the MFS PLC emulator (mfs/setups): loading, validation and which device runs which move.
import { test, expect } from '../../sap-plugin';
import { deviceFor, loadSetup, SetupSchema, validateSetup, type Setup } from '../../mfs/setup.mts';

const example = loadSetup('sap-example');
const runBy = (src: string, dst: string) => deviceFor(example, src, dst)?.id;

test('the SAP example setup loads with its four PLCs and the made-up telegram layout', () => {
	expect(example.plcs.map((plc) => plc.id)).toEqual(['CONS', 'SRM1', 'SRM2', 'SRM3']);
	expect(example.layout.interfaceType).toBe('DEMO');
	expect(validateSetup(example)).toEqual([]);
});

test('a setup with wrong references lists every problem', () => {
	const broken: Setup = {
		...example,
		devices: [
			...example.devices,
			{
				id: 'SRM1',
				type: 'conveyor',
				plc: 'NOPE',
				from: 'IP',
				to: 'NOWHERE',
				travelMs: 1,
				capacity: 1
			}
		]
	};
	expect(validateSetup(broken)).toEqual([
		'device id "SRM1" is used twice',
		'SRM1: unknown PLC "NOPE"',
		'SRM1: unknown point "NOWHERE"',
		// The second SRM1 is a conveyor, so the rack drawn for SRM1 no longer belongs to a crane.
		'view: "SRM1" is not a stacker crane'
	]);
});

test('drawing positions must cover every point and name real devices', () => {
	const view = example.view;
	expect(view).toBeDefined();
	const { GI: _dropped, ...points } = view?.points ?? {};
	const broken: Setup = {
		...example,
		view: {
			width: 1,
			height: 1,
			points: { ...points, NOWHERE: { x: 0, y: 0 } },
			racks: { TCAR: { x: 0, y: 0 } }
		}
	};
	expect(validateSetup(broken)).toEqual([
		'view: unknown point "NOWHERE"',
		'view: no position for point "GI"',
		'view: "TCAR" is not a stacker crane'
	]);
});

test('a setup file with wrong field types is rejected with the field named', () => {
	const result = SetupSchema.safeParse({
		...example,
		devices: [{ id: 'X', type: 'conveyor', plc: 'CONS' }]
	});
	expect(result.success).toBe(false);
	expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
		'devices.0.from',
		'devices.0.to',
		'devices.0.travelMs',
		'devices.0.capacity'
	]);
});

test('each move is run by the device that physically connects the two places, and only by it', () => {
	expect(runBy('GR-IN', 'IP')).toBe('CV-GR');
	expect(runBy('IP', 'A2-IN')).toBe('TCAR');
	expect(runBy('A2-IN', 'A2-10-05')).toBe('SRM2');
	expect(runBy('A2-03-01', 'A2-OUT')).toBe('SRM2');
	// Outside the aisle's bins, into another aisle, against the conveyor's direction, or without a connection.
	expect(runBy('A2-IN', 'A2-11-01')).toBeUndefined();
	expect(runBy('A2-IN', 'A1-01-01')).toBeUndefined();
	expect(runBy('IP', 'GR-IN')).toBeUndefined();
	expect(runBy('GR-IN', 'A1-01-01')).toBeUndefined();
});
