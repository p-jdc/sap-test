// Runs the PLC emulator as a service, for a real EWM to connect to, or with the fake EWM for a demo.
//   node mfs/server.mts        (or bun; from sap-tests)
// Settings by environment:
//   MFS_SETUP         mock setup in setups/ (default sap-example)
//   MFS_HOST          address the PLC ports and the control API listen on (default 127.0.0.1)
//   MFS_BASE_PORT     first PLC port, the others follow (default 47101; 0 = free ports)
//   MFS_CONTROL_PORT  HTTP control API (default 47100; 0 = a free port)
//   MFS_SPEED         time factor (default 1)
//   MFS_FAKE_EWM      1 = also start the fake EWM, connected to all PLCs; its actions are under /ewm
// When ready it prints one line `MFS_READY {"control":…,"plcs":{…},"fakeEwm":…}` for programs that start it.
import { createServer } from 'node:http';
import { z } from 'zod';
import { Emulator } from './emulator.mts';
import { FakeEwm } from './fake-ewm.mts';
import { fail, json, readBody, requestTarget, UserError } from './http.mts';
import { ScenarioRunner } from './scenario.mts';
import { loadSetup } from './setup.mts';

const env = process.env;
const host = env.MFS_HOST || '127.0.0.1';
const port = (value: string | undefined, fallback: number) =>
	value === undefined || value === '' ? fallback : Number(value);
const setup = loadSetup(env.MFS_SETUP || 'sap-example');
const speed = Number(env.MFS_SPEED || 1);
const emulator = new Emulator({
	setup,
	host,
	basePort: port(env.MFS_BASE_PORT, 47101),
	speed
});
const plcs = await emulator.start();
const ewm = env.MFS_FAKE_EWM === '1' ? new FakeEwm({ setup }) : undefined;
await ewm?.connect(plcs);

const RetrieveBody = z.object({ to: z.string().min(1) });

/** The fake EWM's actions: what a warehouse clerk would trigger in EWM. */
async function ewmRoute(
	fake: FakeEwm,
	request: Parameters<typeof readBody>[0],
	response: Parameters<typeof json>[0]
) {
	const { method, path, parts } = requestTarget(request);
	if (method === 'GET' && path === '/ewm/state') return json(response, 200, fake.snapshot());
	const hu = parts[2];
	try {
		if (method === 'POST' && parts[1] === 'hus' && hu && parts[3] === 'retrieve') {
			fake.retrieve(hu, (await readBody(request, RetrieveBody)).to);
			return json(response, 200, { ok: true });
		}
		if (method === 'POST' && parts[1] === 'hus' && hu && parts[3] === 'picked') {
			fake.picked(hu);
			return json(response, 200, { ok: true });
		}
	} catch (error) {
		if (error instanceof UserError) throw error;
		throw new UserError(error instanceof Error ? error.message : String(error), 409);
	}
	throw new UserError(`no route ${method} ${path}`, 404);
}

const scenarios = new ScenarioRunner({ emulator, ewm, speed });
const StartScenarioBody = z.object({ name: z.string().min(1) });

/** Scenarios: list the ones this Mock PLC can run, start one, and pause, resume or stop the run. */
async function scenarioRoute(
	request: Parameters<typeof readBody>[0],
	response: Parameters<typeof json>[0]
) {
	const { method, path } = requestTarget(request);
	if (method === 'GET' && path === '/scenarios') return json(response, 200, scenarios.available());
	if (method === 'GET' && path === '/scenario')
		return json(response, 200, scenarios.state() ?? null);
	if (method === 'POST' && path === '/scenario/start')
		return json(response, 201, scenarios.start((await readBody(request, StartScenarioBody)).name));
	if (method === 'POST' && path === '/scenario/pause')
		return json(response, 200, (scenarios.pause(), { ok: true }));
	if (method === 'POST' && path === '/scenario/resume')
		return json(response, 200, (scenarios.resume(), { ok: true }));
	if (method === 'POST' && path === '/scenario/stop')
		return json(response, 200, (scenarios.stop(), { ok: true }));
	throw new UserError(`no route ${method} ${path}`, 404);
}

const control = createServer((request, response) => {
	const [first = ''] = requestTarget(request).parts;
	const handled =
		first === 'ewm'
			? ewm
				? ewmRoute(ewm, request, response)
				: Promise.reject(new UserError('no fake EWM in this emulator (MFS_FAKE_EWM=1)', 404))
			: first === 'scenario' || first === 'scenarios'
				? scenarioRoute(request, response)
				: emulator.handle(request, response);
	handled.catch((error: unknown) => fail(response, error));
});
await new Promise<void>((resolve) =>
	control.listen(port(env.MFS_CONTROL_PORT, 47100), host, () => resolve())
);
const address = control.address();
const controlPort = typeof address === 'object' && address ? address.port : 0;

console.log(`PLC emulator, setup ${setup.name}${ewm ? ', with the fake EWM' : ''}`);
for (const [plc, plcPort] of Object.entries(plcs))
	console.log(`  PLC ${plc.padEnd(4)} on port ${plcPort}`);
console.log(
	`  control API on http://${host}:${controlPort} (GET /health, /setup, /state, /log, /events, /scenarios, /scenario)`
);
console.log(`MFS_READY ${JSON.stringify({ control: controlPort, plcs, fakeEwm: Boolean(ewm) })}`);
emulator.onEvent((event) =>
	console.log(`${new Date(event.at).toISOString().slice(11, 23)}  ${event.text}`)
);

const shutdown = () => {
	ewm?.close();
	control.close();
	void emulator.stop().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
