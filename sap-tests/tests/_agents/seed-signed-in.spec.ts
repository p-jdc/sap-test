// Seed for the Playwright test agents when the flow starts signed in to a system of systems.json
// (SAP, Ariba, ...). It belongs to every system's project: run it with the system's id as the
// project, and that project's sign-in (setup/sign-in.setup.ts) signs in first, without a trace and
// in a browser of its own. This test only opens the system's address with the saved session and
// hands the signed-in page to the agent. Skipped without the system's values in .env.
// When the session limits the hosts (the planner started from the Test Lab app), the browser
// reaches no other host: sap-plugin/agent-hosts.ts.
import { test, signInSystem } from '../../sap-plugin';
import { limitHosts } from '../../sap-plugin/agent-hosts';
import { requireEnv } from '../../helpers/env';

test('seed: signed in', async ({ page, context, system: id }) => {
	test.skip(!id, 'Run this seed in the project of a system from systems.json, for example "sap".');
	const { env } = signInSystem(id!);
	requireEnv(env.url, env.user, env.password);
	await limitHosts(context);
	await page.goto(process.env[env.url]!);
});
