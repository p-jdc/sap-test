import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

/**
 * A forward proxy on this computer that reaches only the hosts of one planner session. The
 * planner's browser sends every request through it (the seed tests set it as the context's proxy),
 * so the limit also holds where Playwright's request routing does not look: the target of a
 * redirect, a service worker, a WebSocket. A request to another host or port, this computer and
 * the network the app runs in included, gets 403 and no connection is made.
 *
 * Each host's name is resolved once, when the session starts, and every connection goes to that
 * address: a name that later answers with another address (of this computer, of the app's
 * network) changes nothing.
 *
 * It connects straight to the host: an application reachable only through a company proxy
 * (HTTPS_PROXY) cannot be planned from the app.
 */
export type HostProxy = {
	url: string;
	close: () => void;
	/** The hosts whose name had no address at the start: the proxy refuses them. */
	unresolved: string[];
};

/** Finds the address of a host name; the default asks the system, IPv4 first. */
export type Resolve = (host: string) => Promise<string>;

const systemResolve: Resolve = async (host) => {
	const found = await lookup(host, { all: true });
	const first = found.find((a) => a.family === 4) ?? found[0];
	if (!first) throw new Error(`${host} has no address.`);
	return first.address;
};

/** A host name as the proxy compares it: lower case, an IPv6 address without its brackets. */
const hostName = (host: string) => host.toLowerCase().replaceAll(/^\[|\]$/g, '');

/** `host:port` as the proxy's list holds it. */
export const endpoint = (host: string, port: number) => `${hostName(host)}:${port}`;

/**
 * The endpoint of a web address: its host with the port of its scheme when it names none, or null
 * for anything but http(s).
 */
export function endpointOf(address?: string): string | null {
	try {
		const url = new URL(address ?? '');
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return endpoint(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
	} catch {
		return null;
	}
}

const REFUSED = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/** `host:port` of a CONNECT request (`[address]:port` for IPv6), or null when it is not one. */
function authority(value = ''): { host: string; port: number } | null {
	const match = /^(\[[0-9a-f:.]+\]|[^:/@\s]+):(\d{1,5})$/i.exec(value);
	return match ? { host: match[1]!, port: Number(match[2]) } : null;
}

/**
 * Starts the proxy on a free port of 127.0.0.1. `endpoints` are the `host:port` it may connect to
 * (see `endpoint`). A host whose name has no address is not reachable in this session.
 */
export async function startHostProxy(
	endpoints: ReadonlySet<string>,
	resolve: Resolve = systemResolve
): Promise<HostProxy> {
	// Once per host, now: what a name answers later does not matter.
	const pinned = new Map<string, string>();
	const unresolved: string[] = [];
	await Promise.all(
		[...new Set([...endpoints].map((e) => e.slice(0, e.lastIndexOf(':'))))].map(async (host) => {
			if (net.isIP(host)) pinned.set(host, host);
			else {
				const address = await resolve(host).catch(() => null);
				if (address && net.isIP(address)) pinned.set(host, address);
				else unresolved.push(host);
			}
		})
	);
	/** The address to connect to, or null when the proxy must not or cannot. */
	const target = (host: string, port: number) =>
		endpoints.has(endpoint(host, port)) ? (pinned.get(hostName(host)) ?? null) : null;

	const open = new Set<net.Socket>();
	/** The requests to hosts over plain http that are under way. */
	const forwarded = new Set<http.ClientRequest>();
	const track = (socket: net.Socket) => {
		open.add(socket);
		socket.once('close', () => {
			open.delete(socket);
		});
		socket.on('error', () => {
			socket.destroy();
		});
	};

	// Plain http: the browser sends the whole address in the request line.
	const server = http.createServer((request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? '');
		} catch {
			response.writeHead(400).end();
			return;
		}
		const port = Number(url.port || 80);
		const address = url.protocol === 'http:' ? target(url.hostname, port) : null;
		if (!address) {
			response.writeHead(403).end();
			return;
		}
		// The Host header keeps the name; the connection goes to the pinned address.
		const headers = Object.fromEntries(
			Object.entries(request.headers).filter(([name]) => !name.startsWith('proxy-'))
		);
		const upstream = http.request(
			{ host: address, port, method: request.method, path: url.pathname + url.search, headers },
			(answer) => {
				// A host that drops the connection in the middle of its answer.
				answer.on('error', () => {
					response.destroy();
				});
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(response);
			}
		);
		forwarded.add(upstream);
		upstream.on('error', () => {
			if (response.headersSent) response.destroy();
			else response.writeHead(502).end();
		});
		upstream.once('close', () => {
			forwarded.delete(upstream);
		});
		// The browser gave up, or the session ended: the connection to the host goes too.
		response.once('close', () => {
			upstream.destroy();
		});
		request.pipe(upstream);
	});

	// https and WebSockets: a tunnel to the host, which the browser encrypts itself.
	server.on('connect', (request, client: net.Socket, head: Buffer) => {
		track(client);
		const to = authority(request.url);
		const address = to ? target(to.host, to.port) : null;
		if (!to || !address) {
			client.end(REFUSED);
			return;
		}
		const upstream = net.connect(to.port, address, () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		track(upstream);
		upstream.once('error', () => {
			client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
		});
		upstream.once('close', () => {
			client.destroy();
		});
		client.once('close', () => {
			upstream.destroy();
		});
	});
	server.on('connection', track);

	await new Promise<void>((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The proxy has no port.');
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => {
			server.close();
			for (const socket of open) socket.destroy();
			for (const request of forwarded) request.destroy();
		},
		unresolved
	};
}
