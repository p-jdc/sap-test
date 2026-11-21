// Shows the emulator at work without an SAP system: the fake EWM drives SAP's example warehouse over real TCP
// channels, and every telegram and device action is printed as it happens.
//   bun run mfs:demo             (from sap-tests; add -- --all to also show acknowledgements and life telegrams)
import type { LogEntry } from './channel.mts';
import { Emulator } from './emulator.mts';
import { FakeEwm, type EwmHuStatus } from './fake-ewm.mts';
import { loadSetup } from './setup.mts';

const showAll = process.argv.includes('--all');
const speed = 4;
const setup = loadSetup('sap-example');
const emulator = new Emulator({ setup, speed });
const ewm = new FakeEwm({ setup });
const started = Date.now();
const time = (at: number) => `${((at - started) / 1000).toFixed(1).padStart(5)}s`;

const describe = (entry: LogEntry) => {
	const fields = Object.entries(entry.fields)
		.filter(([, value]) => value !== '')
		.map(([name, value]) => `${name}=${value}`)
		.join(' ');
	return `${time(entry.at)}  ${entry.from.padEnd(4)} → ${entry.to.padEnd(4)} ${entry.type.padEnd(4)} #${entry.seq || '----'}  ${fields}${entry.note ? `  [${entry.note}]` : ''}`;
};
emulator.onLog((entry) => {
	if (showAll || (entry.type !== 'ACK' && entry.type !== 'LIFE') || entry.note)
		console.log(describe(entry));
});
emulator.onEvent((event) => console.log(`${time(event.at)}  · ${event.text}`));

const until = async (what: string, check: () => boolean, timeoutMs = 30_000) => {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};
const status = (hu: string, expected: EwmHuStatus) => () => ewm.hu(hu)?.status === expected;
const step = (text: string) => console.log(`\n=== ${text}`);

try {
	const ports = await emulator.start();
	console.log(
		`Setup ${setup.name}: PLCs ${Object.entries(ports)
			.map(([plc, port]) => `${plc}:${port}`)
			.join(', ')}, speed ×${speed}`
	);
	await ewm.connect(ports);

	step('Putaway: HU 100001 enters at goods receipt and is stored');
	emulator.enter('100001');
	await until('100001 stored', status('100001', 'stored'));

	step('Contour error: HU 100002 fails the check at the identification point and goes to clearing');
	emulator.enter('100002', undefined, { idPoint: 'CONT' });
	await until('100002 in clearing', status('100002', 'in-clearing'));

	step('No read: the identification point cannot read HU 100003');
	emulator.enter('100003', undefined, { idPoint: 'NORD' });
	await until('no-read HU in clearing', () => ewm.hu('NOREAD-1')?.status === 'in-clearing');

	step('Bin occupied: the crane finds the bin full, EWM sends HU 100004 to another bin');
	emulator.enter('100004', undefined, { binOccupied: true });
	await until('100004 stored', status('100004', 'stored'));

	step('Pick point: HU 100001 comes out for picking and goes back into storage');
	ewm.retrieve('100001', 'PP');
	await until('100001 at pick point', status('100001', 'at-pick-point'));
	ewm.picked('100001');
	await until('100001 stored again', status('100001', 'stored'));

	step('Goods issue: HU 100004 is removed to goods issue');
	ewm.retrieve('100004', 'GI');
	await until('100004 shipped', status('100004', 'shipped'));

	step('Layout error: a task for a connection the layout does not have is refused');
	const tanum = ewm.sendTask('SRM1', '100001', 'GR-IN', 'A1-01-01');
	await until('task answered', () => ewm.tasks.get(tanum)?.status === 'failed');

	step('Result in the fake EWM');
	for (const record of ewm.hus.values())
		console.log(
			`  ${record.hu.padEnd(10)} ${record.status.padEnd(14)} ${record.path.join(' → ')}${record.bin ? `  (bin ${record.bin})` : ''}`
		);
} finally {
	ewm.close();
	await emulator.stop();
}
