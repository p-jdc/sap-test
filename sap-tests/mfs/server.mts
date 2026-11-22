// Runs the PLC emulator as a service, for a real EWM to connect to, or with the fake EWM for a demo.
//   node mfs/server.mts        (or bun; from sap-tests)
// Settings by environment:
//   MFS_SETUP         mock setup in setups/ (default sap-example)
//   MFS_HOST          address the PLC ports listen on (default 127.0.0.1)
//   MFS_CONTROL_HOST  address the control API listens on (default 127.0.0.1)
//   MFS_CONTROL_TOKEN token every control API request must carry; required when MFS_CONTROL_HOST
//                     is not this computer
//   MFS_BASE_PORT     first PLC port, the others follow (default 47101; 0 = free ports)
//   MFS_CONTROL_PORT  HTTP control API (default 47100; 0 = a free port)
//   MFS_SPEED         time factor (default 1)
//   MFS_FAKE_EWM      1 = also start the fake EWM, connected to all PLCs; its actions are under /ewm
// When ready it prints one line `MFS_READY {"control":…,"plcs":{…},"fakeEwm":…}` for programs that start it.
import { createServer } from 'node:http';
import { z } from 'zod';
import { Emulator } from './emulator.mts';
import { FakeEwm } from './fake-ewm.mts';
import { authorize, fail, isLoopback, json, readBody, requestTarget, UserError } from './http.mts';
import { HuNumbersSchema, ScenarioRunner, ScenarioSchema } from './scenario.mts';
import { loadSetup } from './setup.mts';

const env = process.env;
const host = env.MFS_HOST || '127.0.0.1';
// The control API has its own address: the PLC ports must be reachable by EWM, the control API
// only by whoever runs the tests. Beyond this computer it needs a token.
const controlHost = env.MFS_CONTROL_HOST || '127.0.0.1';
const controlToken = env.MFS_CONTROL_TOKEN || undefined;
if (!isLoopback(controlHost) && !controlToken) {
	console.error(
		`MFS_CONTROL_HOST=${controlHost} opens the control API to the network. Set MFS_CONTROL_TOKEN as well; requests then need "Authorization: Bearer <token>".`
	);
	process.exit(1);
}
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
/**
 * A scenario file by name, or a whole scenario written by the caller (a test's own, one-off situation). `hus`
 * gives its HUs their numbers: needed against a real EWM, which must know an HU before it arrives.
 */
const hus = HuNumbersSchema.optional();
const StartScenarioBody = z.union([
	z.strictObject({ name: z.string().min(1), hus }),
	z.strictObject({ scenario: ScenarioSchema, name: z.string().min(1).optional(), hus })
]);

/** Scenarios: list the ones this Mock PLC can run, start one, and pause, resume or stop the run. */
async function scenarioRoute(
	request: Parameters<typeof readBody>[0],
	response: Parameters<typeof json>[0]
) {
	const { method, path } = requestTarget(request);
	if (method === 'GET' && path === '/scenarios') return json(response, 200, scenarios.available());
	if (method === 'GET' && path === '/scenario')
		return json(response, 200, scenarios.state() ?? null);
	if (method === 'POST' && path === '/scenario/start') {
		const body = await readBody(request, StartScenarioBody);
		return json(
			response,
			201,
			scenarios.start(
				'scenario' in body ? { name: body.name ?? 'inline', ...body.scenario } : body.name,
				body.hus
			)
		);
	}
	if (method === 'POST' && path === '/scenario/pause')
		return json(response, 200, (scenarios.pause(), { ok: true }));
	if (method === 'POST' && path === '/scenario/resume')
		return json(response, 200, (scenarios.resume(), { ok: true }));
	if (method === 'POST' && path === '/scenario/stop')
		return json(response, 200, (scenarios.stop(), { ok: true }));
	throw new UserError(`no route ${method} ${path}`, 404);
}

/** Answers one request. Async, so that whatever a request throws ends in an answer, not in the process. */
async function route(
	request: Parameters<typeof readBody>[0],
	response: Parameters<typeof json>[0]
): Promise<void> {
	authorize(request, controlToken);
	const [first = ''] = requestTarget(request).parts;
	if (first === 'scenario' || first === 'scenarios') return scenarioRoute(request, response);
	if (first !== 'ewm') return emulator.handle(request, response);
	if (!ewm) throw new UserError('no fake EWM in this emulator (MFS_FAKE_EWM=1)', 404);
	return ewmRoute(ewm, request, response);
}

const control = createServer((request, response) => {
	route(request, response).catch((error: unknown) => fail(response, error));
});
await new Promise<void>((resolve) =>
	control.listen(port(env.MFS_CONTROL_PORT, 47100), controlHost, () => resolve())
);
const address = control.address();
const controlPort = typeof address === 'object' && address ? address.port : 0;

console.log(`PLC emulator, setup ${setup.name}${ewm ? ', with the fake EWM' : ''}`);
for (const [plc, plcPort] of Object.entries(plcs))
	console.log(`  PLC ${plc.padEnd(4)} on port ${plcPort}`);
console.log(
	`  control API on http://${controlHost}:${controlPort} (GET /health, /setup, /state, /log, /events, /scenarios, /scenario)`
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
