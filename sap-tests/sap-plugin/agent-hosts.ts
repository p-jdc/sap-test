// The hosts a test agent's browser may reach, when its session limits them. The Test Lab app
// starts the planner on an address a person typed and sets SAP_AGENT_HOSTS to that address's host
// (and those of SAP_AGENT_EXTRA_HOSTS): the seed tests then block every request of the browser to
// another host. A page the agent visits, or the agent itself through JavaScript in the page, can
// so reach neither this computer, nor the network the app runs in, nor a site to send what it saw
// to. Without SAP_AGENT_HOSTS (Claude Code, VS Code, Codex) nothing is limited.
// The limit is held by a proxy the app starts for the session (SAP_AGENT_PROXY,
// src/lib/server/agent-proxy.ts): Playwright's request routing alone does not see the target of a
// redirect.
import type { BrowserContext } from '@playwright/test';

/** The hosts of a comma-separated setting: `host` or `host:port`, as URL.host gives them. */
export function agentHosts(...settings: (string | undefined)[]): Set<string> {
	return new Set(
		settings
			.flatMap((setting) => (setting ?? '').split(','))
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean)
	);
}

/**
 * Whether the browser may request this address. Addresses that reach no host (about:, data:, blob:)
 * are harmless; everything else must be http(s) or a WebSocket to one of the hosts.
 */
export function hostAllowed(address: string, hosts: ReadonlySet<string>): boolean {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return false;
	}
	if (['about:', 'data:', 'blob:'].includes(url.protocol)) return true;
	if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
	return hosts.has(url.host.toLowerCase());
}

/**
 * The context's proxy for a session with limited hosts: the one the app started for it
 * (SAP_AGENT_PROXY), also for addresses of this computer, which a browser otherwise reaches
 * directly. A seed test sets it with `test.use({ proxy: agentProxy() })`.
 */
export function agentProxy(): { server: string; bypass: string } | undefined {
	const server = process.env.SAP_AGENT_PROXY;
	return server ? { server, bypass: '<-loopback>' } : undefined;
}

/**
 * Limits the context to the hosts of its session (SAP_AGENT_HOSTS), or to `hosts`. What holds the
 * limit is the session's proxy (agentProxy), which refuses every other host, also as the target of
 * a redirect. On top of it, a request or WebSocket to another host is aborted here, before it is
 * sent, and WebRTC is taken from the pages. Does nothing when there is no host.
 */
export async function limitHosts(
	context: BrowserContext,
	hosts?: ReadonlySet<string>
): Promise<void> {
	const session = agentHosts(
		process.env.SAP_AGENT_HOSTS,
		process.env.SAP_AGENT_HOSTS ? process.env.SAP_AGENT_EXTRA_HOSTS : undefined
	);
	// A session that limits its hosts and has no proxy would only seem limited.
	if (!hosts && session.size > 0 && !process.env.SAP_AGENT_PROXY)
		throw new Error('SAP_AGENT_HOSTS is set without SAP_AGENT_PROXY: the hosts cannot be limited.');
	const allowed = hosts ?? session;
	if (allowed.size === 0) return;
	await context.addInitScript(() => {
		for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'])
			Reflect.deleteProperty(globalThis, name);
	});
	await context.route('**/*', (route) =>
		hostAllowed(route.request().url(), allowed) ? route.fallback() : route.abort('blockedbyclient')
	);
	await context.routeWebSocket('**/*', (socket) => {
		if (hostAllowed(socket.url(), allowed)) socket.connectToServer();
		else void socket.close({ code: 1008, reason: 'This host is not allowed in this session.' });
	});
}
