// Seed for the Playwright test agents (.claude/agents/playwright-test-*.md). The planner and the
// generator run this test first and then take over its page. Importing `test` from sap-plugin is
// what matters: it registers the SAP selector engines and adds getByRoleUI5, locateSID and the
// other SAP methods to the page. The page starts empty; the agent opens the address it was given.
// For a flow that starts signed in (SAP, Ariba, ...) use seed-signed-in.spec.ts instead.
import { test } from '../../sap-plugin';

test('seed', async ({ page }) => {
	await page.goto('about:blank');
});
