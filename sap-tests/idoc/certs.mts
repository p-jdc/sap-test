// Test certificates for the IDoc receiver, made with openssl: a test CA, a server certificate for the receiver
// and a client certificate standing in for SAP's (mutual TLS). For a local receiver and the tests only. On the
// cluster the certificates come from the cluster's issuer, and SAP's client certificate from STRUST.
//   node idoc/certs.mts [host ...]   (default: localhost 127.0.0.1; writes to idoc/certs/, which git ignores)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TestCerts {
	ca: string;
	serverCert: string;
	serverKey: string;
	clientCert: string;
	clientKey: string;
}

function openssl(args: string[], cwd: string): void {
	const result = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
	if (result.error)
		throw new Error(
			'openssl not found. Install it, or give the receiver certificates of your own.'
		);
	if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
}

/** True when openssl can be run here. */
export function hasOpenssl(): boolean {
	return !spawnSync('openssl', ['version']).error;
}

/** Signs a certificate for `name` with the test CA in `dir`. */
function issue(dir: string, name: string, subject: string, extensions: string): void {
	writeFileSync(join(dir, `${name}.ext`), extensions);
	openssl(
		[
			'req',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			`${name}.key`,
			'-out',
			`${name}.csr`,
			'-subj',
			subject
		],
		dir
	);
	openssl(
		[
			'x509',
			'-req',
			'-in',
			`${name}.csr`,
			'-CA',
			'ca.pem',
			'-CAkey',
			'ca.key',
			'-set_serial',
			`0x${randomBytes(8).toString('hex')}`,
			'-days',
			'30',
			'-out',
			`${name}.pem`,
			'-extfile',
			`${name}.ext`
		],
		dir
	);
}

/** Writes a test CA, a server certificate for `hosts` and a client certificate into `dir`. */
export function makeTestCerts(
	dir: string,
	hosts: string[] = ['localhost', '127.0.0.1']
): TestCerts {
	mkdirSync(dir, { recursive: true });
	openssl(
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			'ca.key',
			'-out',
			'ca.pem',
			'-days',
			'30',
			'-subj',
			'/CN=SAP Test Lab IDoc mock test CA',
			'-addext',
			'basicConstraints=critical,CA:TRUE',
			'-addext',
			'keyUsage=critical,keyCertSign,cRLSign'
		],
		dir
	);
	const san = hosts.map((host) => (isIP(host) ? `IP:${host}` : `DNS:${host}`)).join(',');
	issue(
		dir,
		'server',
		`/CN=${hosts[0]}`,
		`subjectAltName=${san}\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n`
	);
	issue(
		dir,
		'client',
		'/CN=SAP test client',
		'extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
	);
	const read = (name: string) => readFileSync(join(dir, name), 'utf8');
	return {
		ca: read('ca.pem'),
		serverCert: read('server.pem'),
		serverKey: read('server.key'),
		clientCert: read('client.pem'),
		clientKey: read('client.key')
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = fileURLToPath(new URL('certs/', import.meta.url));
	const hosts = process.argv.slice(2);
	makeTestCerts(dir, hosts.length > 0 ? hosts : undefined);
	console.log(`Test certificates in ${dir}:`);
	console.log('  IDOC_TLS_CERT=idoc/certs/server.pem IDOC_TLS_KEY=idoc/certs/server.key');
	console.log(
		'  IDOC_TLS_CA=idoc/certs/ca.pem   (only for mutual TLS; client.pem/client.key play SAP)'
	);
}
