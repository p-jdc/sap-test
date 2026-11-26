import http from 'node:http';
import net from 'node:net';

/**
 * A forward proxy on this computer that reaches only the hosts of one planner session. The
 * planner's browser sends every request through it (the seed tests set it as the context's proxy),
 * so the limit also holds where Playwright's request routing does not look: the target of a
 * redirect, a service worker, a WebSocket. A request to another host, this computer and the
 * network the app runs in included, gets 403 and no connection is made.
 *
 * It connects straight to the host: an application reachable only through a company proxy
 * (HTTPS_PROXY) cannot be planned from the app.
 */
export type HostProxy = { url: string; close: () => void };

/**
 * Whether the proxy may connect to `host:port`. The hosts are as URL.host gives them: without the
 * port for 80 and 443, so a host named without a port is reachable on both.
 */
export function proxyAllows(host: string, port: number, hosts: ReadonlySet<string>): boolean {
	const name = host.toLowerCase().replaceAll(/^\[|\]$/g, '');
	const bare = name.includes(':') ? `[${name}]` : name;
	return hosts.has(port === 80 || port === 443 ? bare : `${bare}:${port}`);
}

const REFUSED = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/** `host:port` of a CONNECT request (`[address]:port` for IPv6), or null when it is not one. */
function authority(value = ''): { host: string; port: number } | null {
	const match = /^(\[[0-9a-f:.]+\]|[^:/@\s]+):(\d{1,5})$/i.exec(value);
	return match ? { host: match[1]!, port: Number(match[2]) } : null;
}

/** Starts the proxy for these hosts on a free port of 127.0.0.1. */
export async function startHostProxy(hosts: ReadonlySet<string>): Promise<HostProxy> {
	const open = new Set<net.Socket>();
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
		if (url.protocol !== 'http:' || !proxyAllows(url.hostname, port, hosts)) {
			response.writeHead(403).end();
			return;
		}
		const headers = Object.fromEntries(
			Object.entries(request.headers).filter(([name]) => !name.startsWith('proxy-'))
		);
		const upstream = http.request(
			{
				host: url.hostname,
				port,
				method: request.method,
				path: url.pathname + url.search,
				headers
			},
			(answer) => {
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(response);
			}
		);
		upstream.on('error', () => {
			if (response.headersSent) response.destroy();
			else response.writeHead(502).end();
		});
		request.pipe(upstream);
	});

	// https and WebSockets: a tunnel to the host, which the browser encrypts itself.
	server.on('connect', (request, client: net.Socket, head: Buffer) => {
		track(client);
		const to = authority(request.url);
		if (!to || !proxyAllows(to.host, to.port, hosts)) {
			client.end(REFUSED);
			return;
		}
		const upstream = net.connect(to.port, to.host, () => {
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

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The proxy has no port.');
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => {
			server.close();
			for (const socket of open) socket.destroy();
		}
	};
}
