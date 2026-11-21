// Signs in once per run to each system of systems.json and saves the session its tests start
// with. Each system's sign-in project (playwright.config.ts) runs only that system's sign-in, picked
// by its tag, and runs without a trace: the password typed here must not end up in one (see
// sap-plugin/session.ts).
import {
	test as setup,
	clearSession,
	saveSession,
	signIn,
	signingIn,
	signInSystems,
	signInTag
} from '../sap-plugin';
import { requireEnv } from '../helpers/env';

// Also here, not only in the config: an option set in a test file wins over `--trace on` on the
// command line, which would otherwise record the password.
setup.use({ trace: 'off', video: 'off' });

for (const system of signInSystems()) {
	setup(`sign in to ${system.title}`, { tag: signInTag(system) }, async ({ page }) => {
		// Before anything can fail or skip, so no older session is left for the tests.
		clearSession(system.id);
		requireEnv(system.env.url, system.env.user, system.env.password);
		await signingIn(page, () => signIn(page, system));
		await saveSession(page, system.id);
	});
}
