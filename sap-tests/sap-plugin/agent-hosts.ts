// The hosts a test agent's browser may reach, when its session limits them. The Test Lab app
// starts the planner on an address a person typed and sets SAP_AGENT_HOSTS to that address's host
// (and those of SAP_AGENT_EXTRA_HOSTS): the seed tests then block every request of the browser to
// another host. A page the agent visits, or the agent itself through JavaScript in the page, can
// so reach neither this computer, nor the network the app runs in, nor a site to send what it saw
// to. Without SAP_AGENT_HOSTS (Claude Code, VS Code, Codex) nothing is limited.
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
 * Blocks every request and WebSocket of the context to a host outside `hosts`: pages, frames,
 * popups, scripts, `fetch`. Does nothing when no host is given.
 */
export async function limitHosts(
	context: BrowserContext,
	hosts: ReadonlySet<string> = agentHosts(
		process.env.SAP_AGENT_HOSTS,
		process.env.SAP_AGENT_HOSTS ? process.env.SAP_AGENT_EXTRA_HOSTS : undefined
	)
): Promise<void> {
	if (hosts.size === 0) return;
	await context.route('**/*', (route) =>
		hostAllowed(route.request().url(), hosts) ? route.fallback() : route.abort('blockedbyclient')
	);
	await context.routeWebSocket('**/*', (socket) => {
		if (hostAllowed(socket.url(), hosts)) socket.connectToServer();
		else void socket.close({ code: 1008, reason: 'This host is not allowed in this session.' });
	});
}
