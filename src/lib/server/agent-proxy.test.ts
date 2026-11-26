import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { proxyAllows, startHostProxy, type HostProxy } from './agent-proxy.js';

const closers: (() => void)[] = [];

function portOf(server: http.Server): number {
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The server has no port.');
	return address.port;
}
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

/** A local web server; its answer says which one it is. */
async function site(name: string, redirectTo?: string): Promise<{ host: string; hits: string[] }> {
	const hits: string[] = [];
	const server = http.createServer((request, response) => {
		hits.push(request.url ?? '');
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
	return { host: `localhost:${portOf(server)}`, hits };
}

async function proxyFor(...hosts: string[]): Promise<HostProxy> {
	const proxy = await startHostProxy(new Set(hosts));
	closers.push(proxy.close);
	return proxy;
}

/** A plain http request through the proxy, as a browser sends it. */
function through(proxy: HostProxy, address: string): Promise<{ status: number; body: string }> {
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
						resolve({ status: r.statusCode ?? 0, body });
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
		const proxy = await proxyFor(app.host);
		expect(await through(proxy, `http://${app.host}/page?x=1`)).toEqual({
			status: 200,
			body: 'app/page?x=1'
		});
		expect((await through(proxy, `http://${other.host}/settings`)).status).toBe(403);
		expect(other.hits).toEqual([]);
	});

	test('a redirect of an allowed host to another host ends at the proxy', async () => {
		const other = await site('other');
		const app = await site('app', `http://${other.host}/settings`);
		const proxy = await proxyFor(app.host);
		// The browser gets the redirect and asks the proxy for its target, which is refused.
		const first = await through(proxy, `http://${app.host}/redirect`);
		expect(first.status).toBe(302);
		expect((await through(proxy, `http://${other.host}/settings`)).status).toBe(403);
		expect(other.hits).toEqual([]);
	});

	test('tunnels (https, WebSockets) only to the hosts of the session', async () => {
		const app = await site('app');
		const other = await site('other');
		const proxy = await proxyFor(app.host);
		expect(await connect(proxy, app.host)).toBe('HTTP/1.1 200 Connection Established');
		expect(await connect(proxy, other.host)).toBe('HTTP/1.1 403 Forbidden');
		expect(await connect(proxy, '169.254.169.254:80')).toBe('HTTP/1.1 403 Forbidden');
		// No port, or no authority at all: refused, by the proxy or by the server's own parser.
		expect(await connect(proxy, 'no-port.example')).toMatch(/^HTTP\/1\.1 4\d\d /);
		expect(await connect(proxy, 'not an authority')).toMatch(/^HTTP\/1\.1 4\d\d /);
	});
});

describe('proxyAllows', () => {
	const hosts = new Set(['sap.example', 'sap.example:44300', '[::1]:8080']);
	test.each([
		['sap.example', 443, true],
		['SAP.example', 80, true],
		['sap.example', 44300, true],
		['sap.example', 8443, false],
		['elsewhere.example', 443, false],
		['sap.example.elsewhere.example', 443, false],
		['127.0.0.1', 443, false],
		['[::1]', 8080, true],
		['::1', 8080, true],
		['[::1]', 443, false]
	])('%s:%i', (host, port, allowed) => {
		expect(proxyAllows(host, port, hosts)).toBe(allowed);
	});
});
