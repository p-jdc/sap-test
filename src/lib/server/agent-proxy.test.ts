import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { endpoint, endpointOf, startHostProxy, type HostProxy } from './agent-proxy.js';

const closers: (() => void)[] = [];

function portOf(server: http.Server): number {
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The server has no port.');
	return address.port;
}
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

/** A local web server on 127.0.0.1; its answer says which one it is. */
async function site(
	name: string,
	redirectTo?: string
): Promise<{ host: string; port: number; hits: string[] }> {
	const hits: string[] = [];
	const server = http.createServer((request, response) => {
		hits.push(`${request.headers.host}${request.url}`);
		if (redirectTo && request.url === '/redirect')
			response.writeHead(302, { location: redirectTo }).end();
		else response.end(`${name}${request.url}`);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	closers.push(() => {
		server.closeAllConnections();
		server.close();
	});
	// As the browser names it: this computer by name, so that the proxy's list decides.
	return { host: `localhost:${portOf(server)}`, port: portOf(server), hits };
}

/** The proxy for these `host:port`, with names resolved by `resolve` (default: all to 127.0.0.1). */
async function proxyFor(
	hosts: string[],
	resolve: (host: string) => Promise<string> = () => Promise.resolve('127.0.0.1')
): Promise<HostProxy> {
	const proxy = await startHostProxy(new Set(hosts), resolve);
	closers.push(proxy.close);
	return proxy;
}

/** A plain http request through the proxy, as a browser sends it. */
function through(
	proxy: HostProxy,
	address: string
): Promise<{ status: number; body: string; location?: string }> {
	const { hostname, port } = new URL(proxy.url);
	return new Promise((resolve, reject) => {
		http
			.get(
				{ host: hostname, port, path: address, headers: { host: new URL(address).host } },
				(r) => {
					let body = '';
					r.on('data', (chunk: Buffer) => {
						body += chunk.toString();
					});
					r.on('end', () => {
						const { location } = r.headers;
						resolve({ status: r.statusCode ?? 0, body, ...(location ? { location } : {}) });
					});
					// An answer that breaks off half way.
					r.on('error', reject);
					r.on('close', () => {
						if (!r.complete) reject(new Error('The answer broke off.'));
					});
				}
			)
			.on('error', reject);
	});
}

/** The proxy's first answer to a CONNECT, as for https or a WebSocket. */
function connect(proxy: HostProxy, authority: string): Promise<string> {
	const { hostname, port } = new URL(proxy.url);
	return new Promise((resolve, reject) => {
		const socket = net.connect(Number(port), hostname, () => {
			socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
		});
		socket.once('data', (data) => {
			resolve(data.toString().split('\r\n')[0] ?? '');
			socket.destroy();
		});
		socket.once('error', reject);
	});
}

describe('the proxy of a planner session', () => {
	test('reaches the hosts of the session and refuses every other, without connecting', async () => {
		const app = await site('app');
		const other = await site('other');
		const proxy = await proxyFor([app.host]);
		expect(await through(proxy, `http://${app.host}/page?x=1`)).toEqual({
			status: 200,
			body: 'app/page?x=1'
		});
		expect((await through(proxy, `http://${other.host}/settings`)).status).toBe(403);
		expect(other.hits).toEqual([]);
	});

	test('hands a redirect to the browser as it is, and does not follow it', async () => {
		const other = await site('other');
		const app = await site('app', `http://${other.host}/settings`);
		const proxy = await proxyFor([app.host]);
		expect(await through(proxy, `http://${app.host}/redirect`)).toMatchObject({
			status: 302,
			location: `http://${other.host}/settings`
		});
		expect(other.hits).toEqual([]);
		// The browser then asks the proxy for the target, which is refused.
		expect((await through(proxy, `http://${other.host}/settings`)).status).toBe(403);
		expect(other.hits).toEqual([]);
	});

	test('tunnels (https, WebSockets) only to the hosts of the session', async () => {
		const app = await site('app');
		const other = await site('other');
		const proxy = await proxyFor([app.host]);
		expect(await connect(proxy, app.host)).toBe('HTTP/1.1 200 Connection Established');
		expect(await connect(proxy, other.host)).toBe('HTTP/1.1 403 Forbidden');
		expect(await connect(proxy, '169.254.169.254:80')).toBe('HTTP/1.1 403 Forbidden');
		// No port, or no authority at all: refused, by the proxy or by the server's own parser.
		expect(await connect(proxy, 'no-port.example')).toMatch(/^HTTP\/1\.1 4\d\d /);
		expect(await connect(proxy, 'not an authority')).toMatch(/^HTTP\/1\.1 4\d\d /);
	});

	test('only the port of the session: https alone does not open http', async () => {
		const app = await site('app');
		const proxy = await proxyFor(['app.test:443']);
		expect((await through(proxy, 'http://app.test/')).status).toBe(403);
		expect((await through(proxy, `http://app.test:${app.port}/`)).status).toBe(403);
		expect(app.hits).toEqual([]);
	});

	test('a name is resolved once: what it answers later changes nothing', async () => {
		const app = await site('app');
		// A host under someone else's control: first its public address, then one of this network.
		const answers = ['127.0.0.1', '169.254.169.254', '10.0.0.1'];
		const asked: string[] = [];
		const proxy = await proxyFor([`rebind.test:${app.port}`], (host) => {
			asked.push(host);
			return Promise.resolve(String(answers[asked.length - 1]));
		});
		for (const path of ['/one', '/two']) {
			// oxlint-disable-next-line no-await-in-loop -- one after the other, as a page would
			expect(await through(proxy, `http://rebind.test:${app.port}${path}`)).toEqual({
				status: 200,
				body: `app${path}`
			});
		}
		expect(await connect(proxy, `rebind.test:${app.port}`)).toBe(
			'HTTP/1.1 200 Connection Established'
		);
		expect(asked).toEqual(['rebind.test']);
		// The application still sees its own name.
		expect(app.hits).toEqual([`rebind.test:${app.port}/one`, `rebind.test:${app.port}/two`]);
	});

	test('a host without an address is not reachable', async () => {
		const proxy = await proxyFor(['nowhere.test:80'], () =>
			Promise.reject(new Error('no address'))
		);
		expect((await through(proxy, 'http://nowhere.test/')).status).toBe(403);
	});
});

/** A host that sends the start of an answer and then nothing more; it counts its connections. */
async function stalling(drop: boolean): Promise<{ host: string; open: () => number }> {
	const sockets = new Set<net.Socket>();
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { 'content-length': '100' });
		response.write('start');
		if (drop)
			setTimeout(() => {
				response.socket?.destroy();
			}, 20);
	});
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => {
			sockets.delete(socket);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	closers.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return { host: `localhost:${portOf(server)}`, open: () => sockets.size };
}

describe('the proxy and a connection that breaks', () => {
	test('a host that drops its answer half way ends the request, and the proxy goes on', async () => {
		const broken = await stalling(true);
		const app = await site('app');
		const proxy = await proxyFor([broken.host, app.host]);
		await expect(through(proxy, `http://${broken.host}/`)).rejects.toThrow(
			/broke off|aborted|hang up|ECONNRESET|closed/i
		);
		expect((await through(proxy, `http://${app.host}/`)).status).toBe(200);
	});

	test('closing the proxy also closes its connections to the hosts', async () => {
		const slow = await stalling(false);
		const proxy = await proxyFor([slow.host]);
		const pending = through(proxy, `http://${slow.host}/`).catch(() => null);
		await expect.poll(() => slow.open()).toBe(1);
		proxy.close();
		await expect.poll(() => slow.open()).toBe(0);
		await pending;
	});
});

describe('endpoint', () => {
	test('names a host with its port, an IPv6 address without brackets', () => {
		expect(endpoint('SAP.example', 443)).toBe('sap.example:443');
		expect(endpoint('[::1]', 8080)).toBe('::1:8080');
		expect(endpoint('::1', 8080)).toBe('::1:8080');
	});

	test.each([
		['https://sap.example/sap/bc/ui2/flp', 'sap.example:443'],
		['http://sap.example/', 'sap.example:80'],
		['https://sap.example:44300/', 'sap.example:44300'],
		['http://[::1]:8080/', '::1:8080'],
		['ftp://sap.example/', null],
		['sap.example', null]
	])('of a web address is its host on the port of its scheme: %s', (address, expected) => {
		expect(endpointOf(address)).toBe(expected);
	});
});
