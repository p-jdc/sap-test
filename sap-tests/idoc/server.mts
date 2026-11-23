// Runs the IDoc receiver as a service.
//   node idoc/server.mts        (or bun; from sap-tests)
// Settings by environment:
//   IDOC_HOST           address of the IDoc endpoint SAP posts to (default 127.0.0.1)
//   IDOC_PORT           its port (default 47200; 0 = a free port)
//   IDOC_TLS_CERT       server certificate (PEM file); HTTPS instead of HTTP. Required beyond this computer.
//   IDOC_TLS_KEY        its private key (PEM file)
//   IDOC_TLS_CA         CA (PEM file) that signed SAP's client certificate: mutual TLS
//   IDOC_TLS_CLIENT_FINGERPRINT
//                       SHA-256 fingerprint of SAP's client certificate: only that one gets in, not every
//                       certificate the CA signed (openssl x509 -noout -fingerprint -sha256 -in sap.pem)
//   IDOC_USER           user of the type G destination (basic authentication) ...
//   IDOC_PASSWORD       ... and its password. Beyond this computer, set these, or IDOC_TLS_CA with
//                       IDOC_TLS_CLIENT_FINGERPRINT. Set both, and SAP needs both.
//   IDOC_CONTROL_HOST   address of the control API (default 127.0.0.1). Beyond this computer it uses HTTPS with
//                       IDOC_TLS_CERT and IDOC_TLS_KEY, and needs IDOC_CONTROL_TOKEN.
//   IDOC_CONTROL_PORT   its port (default 47201; 0 = a free port)
//   IDOC_CONTROL_TOKEN  token every control API request must carry; required when IDOC_CONTROL_HOST is not
//                       this computer
// Sending IDocs into SAP (POST /send on the control API), in CPI's place. One set of settings per SAP system,
// IDOC_S4_* for S/4HANA and IDOC_EWM_* for EWM (here IDOC_S4_*):
//   IDOC_S4_URL         the system's address, https://host:port (sender.mts). Without it, nothing is sent there.
//   IDOC_S4_CLIENT      its client (sap-client)
//   IDOC_S4_SERVICE     soap (default: /sap/bc/srt/idoc, as CPI) or xml (/sap/bc/idoc_xml)
//   IDOC_S4_USER        user in SAP (basic authentication) ...
//   IDOC_S4_PASSWORD    ... and its password
//   IDOC_S4_TLS_CERT    client certificate (PEM file) SAP maps to a user: mutual TLS, instead of or besides the user
//   IDOC_S4_TLS_KEY     its private key (PEM file)
//   IDOC_S4_TLS_CA      CA (PEM file) to trust for SAP's server certificate, besides the usual ones
//   IDOC_S4_TIMEOUT_MS  how long to wait for SAP's answer (default 60000)
//   IDOC_FAKE_SAP=1     every system without an address gets a stand-in for SAP in this process (fake-sap.mts),
//                       for trying it out
// With a login for SAP, IDOC_CONTROL_TOKEN is required: the control API could otherwise send in its name.
// When ready it prints one line `IDOC_READY {"idocUrl":…,"controlUrl":…}` for programs that start it.
import { readFileSync } from 'node:fs';
import { startFakeSap, type RunningFakeSap } from './fake-sap.mts';
import { startReceiver } from './receiver.mts';
import { SAP_SYSTEMS, type SapService, type SapSystem } from './sender.mts';
import type { SapDestinations } from './receiver.mts';

const env = process.env;
const port = (value: string | undefined, fallback: number) =>
	value === undefined || value === '' ? fallback : Number(value);
const file = (name: string) => {
	const path = env[name];
	return path ? readFileSync(path) : undefined;
};

const cert = file('IDOC_TLS_CERT');
const key = file('IDOC_TLS_KEY');
if (Boolean(cert) !== Boolean(key)) {
	console.error('Set IDOC_TLS_CERT and IDOC_TLS_KEY together.');
	process.exit(1);
}
if (Boolean(env.IDOC_USER) !== Boolean(env.IDOC_PASSWORD)) {
	console.error('Set IDOC_USER and IDOC_PASSWORD together.');
	process.exit(1);
}
const ca = file('IDOC_TLS_CA');
const clientFingerprint = env.IDOC_TLS_CLIENT_FINGERPRINT || undefined;
if (clientFingerprint && !ca) {
	console.error(
		'IDOC_TLS_CLIENT_FINGERPRINT needs IDOC_TLS_CA: the CA that signed that certificate.'
	);
	process.exit(1);
}
if (ca && !cert) {
	console.error(
		'IDOC_TLS_CA needs IDOC_TLS_CERT and IDOC_TLS_KEY: client certificates only work over HTTPS.'
	);
	process.exit(1);
}

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};
// Before S/4HANA and EWM had settings of their own, there was one system, IDOC_SAP_*. Ignoring those would send
// into a stand-in instead without a word.
const old = Object.keys(env).filter((name) => name.startsWith('IDOC_SAP_') && env[name]);
if (old.length > 0)
	fail(
		`${old.join(', ')}: these settings are now one set per SAP system. Rename them to IDOC_S4_… for S/4HANA (IDOC_SAP_URL becomes IDOC_S4_URL) or IDOC_EWM_… for EWM.`
	);
const fakeSap = env.IDOC_FAKE_SAP === '1';
const fakes: RunningFakeSap[] = [];
/** Where IDocs for `system` go, from its IDOC_<SYSTEM>_* settings: the system, a stand-in, or nowhere. */
async function destination(system: SapSystem): Promise<SapDestinations[SapSystem]> {
	const prefix = `IDOC_${system.toUpperCase()}_`;
	const setting = (name: string) => env[prefix + name] || undefined;
	const serviceSetting = setting('SERVICE') ?? 'soap';
	const service: SapService =
		serviceSetting === 'soap' || serviceSetting === 'xml'
			? serviceSetting
			: fail(`${prefix}SERVICE is soap or xml, not "${serviceSetting}".`);
	const url = setting('URL');
	if (!url) {
		if (!fakeSap) return undefined;
		const standIn = await startFakeSap();
		fakes.push(standIn);
		return { target: { url: standIn.url, service }, standIn };
	}
	const sapCert = file(`${prefix}TLS_CERT`);
	const sapKey = file(`${prefix}TLS_KEY`);
	if (Boolean(sapCert) !== Boolean(sapKey))
		fail(`Set ${prefix}TLS_CERT and ${prefix}TLS_KEY together.`);
	const user = setting('USER');
	const password = setting('PASSWORD');
	if (Boolean(user) !== Boolean(password))
		fail(`Set ${prefix}USER and ${prefix}PASSWORD together.`);
	const sapCa = file(`${prefix}TLS_CA`);
	const timeout = setting('TIMEOUT_MS');
	return {
		target: {
			url,
			client: setting('CLIENT'),
			service,
			basicAuth: user && password ? { user, password } : undefined,
			tls: sapCert || sapCa ? { cert: sapCert, key: sapKey, ca: sapCa } : undefined,
			timeoutMs: timeout ? Number(timeout) : undefined
		}
	};
}
const sap: SapDestinations = {};
for (const system of SAP_SYSTEMS) {
	const found = await destination(system);
	if (found) sap[system] = found;
}

let receiver;
try {
	receiver = await startReceiver({
		sap,
		host: env.IDOC_HOST || '127.0.0.1',
		port: port(env.IDOC_PORT, 47200),
		tls: cert && key ? { cert, key, ca, clientFingerprint } : undefined,
		basicAuth:
			env.IDOC_USER && env.IDOC_PASSWORD
				? { user: env.IDOC_USER, password: env.IDOC_PASSWORD }
				: undefined,
		controlHost: env.IDOC_CONTROL_HOST || '127.0.0.1',
		controlPort: port(env.IDOC_CONTROL_PORT, 47201),
		controlToken: env.IDOC_CONTROL_TOKEN || undefined
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const { idocUrl, controlUrl, inbox } = receiver;
const login = [
	env.IDOC_USER && 'user and password',
	ca && (clientFingerprint ? 'the pinned client certificate' : 'a client certificate from the CA')
].filter(Boolean);
console.log('IDoc receiver');
console.log(
	`  IDoc endpoint on ${idocUrl}/idoc/<partner> (login: ${login.join(' and ') || 'none'})`
);
console.log(`  control API on ${controlUrl} (GET /health, /idocs, /replies, /failures, /sent)`);
for (const [system, { target, standIn }] of Object.entries(sap))
	console.log(
		`  sends into ${system} at ${target.url} (${target.service}${standIn ? ', a stand-in for SAP in this process' : ''})`
	);
console.log(`IDOC_READY ${JSON.stringify({ idocUrl, controlUrl })}`);
inbox.onIdoc(({ seq, partner, accepted, idoc: { control } }) =>
	console.log(
		`${new Date().toISOString().slice(11, 23)}  #${seq} ${control.IDOCTYP ?? '?'} ${control.MESTYP ?? '?'} for ${partner}${accepted ? '' : ' (rejected)'}`
	)
);

const shutdown = () => {
	void Promise.all([receiver.close(), ...fakes.map((f) => f.close())]).then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
