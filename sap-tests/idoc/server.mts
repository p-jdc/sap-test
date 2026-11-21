// Runs the IDoc receiver as a service.
//   node idoc/server.mts        (or bun; from sap-tests)
// Settings by environment:
//   IDOC_HOST           address of the IDoc endpoint SAP posts to (default 127.0.0.1)
//   IDOC_PORT           its port (default 47200; 0 = a free port)
//   IDOC_TLS_CERT       server certificate (PEM file); HTTPS instead of HTTP. Required beyond this computer.
//   IDOC_TLS_KEY        its private key (PEM file)
//   IDOC_TLS_CA         CA (PEM file) that signed SAP's client certificate: mutual TLS, only SAP gets in
//   IDOC_USER           user of the type G destination (basic authentication) ...
//   IDOC_PASSWORD       ... and its password. Beyond this computer, set these or IDOC_TLS_CA.
//   IDOC_CONTROL_HOST   address of the control API (default 127.0.0.1)
//   IDOC_CONTROL_PORT   its port (default 47201; 0 = a free port)
//   IDOC_CONTROL_TOKEN  token every control API request must carry; required when IDOC_CONTROL_HOST is not
//                       this computer
// When ready it prints one line `IDOC_READY {"idocUrl":…,"controlUrl":…}` for programs that start it.
import { readFileSync } from 'node:fs';
import { startReceiver } from './receiver.mts';

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
if (ca && !cert) {
	console.error(
		'IDOC_TLS_CA needs IDOC_TLS_CERT and IDOC_TLS_KEY: client certificates only work over HTTPS.'
	);
	process.exit(1);
}

let receiver;
try {
	receiver = await startReceiver({
		host: env.IDOC_HOST || '127.0.0.1',
		port: port(env.IDOC_PORT, 47200),
		tls: cert && key ? { cert, key, ca } : undefined,
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
const login = [env.IDOC_USER && 'user and password', ca && 'client certificate'].filter(Boolean);
console.log('IDoc receiver');
console.log(
	`  IDoc endpoint on ${idocUrl}/idoc/<partner> (login: ${login.join(' or ') || 'none'})`
);
console.log(`  control API on ${controlUrl} (GET /health, /idocs, /replies, /failures)`);
console.log(`IDOC_READY ${JSON.stringify({ idocUrl, controlUrl })}`);
inbox.onIdoc(({ seq, partner, accepted, idoc: { control } }) =>
	console.log(
		`${new Date().toISOString().slice(11, 23)}  #${seq} ${control.IDOCTYP ?? '?'} ${control.MESTYP ?? '?'} for ${partner}${accepted ? '' : ' (rejected)'}`
	)
);

const shutdown = () => {
	void receiver.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
