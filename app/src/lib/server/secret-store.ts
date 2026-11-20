/**
 * The operating system's credential store (macOS Keychain, Windows Credential Manager, libsecret on
 * Linux) through `Bun.secrets`. Settings saved in the app go here instead of a file in the repo.
 */
export type SecretStore = {
	/** The stored value, or null when there is none or the store cannot be reached. */
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
	/** False where there is no credential store: not running on Bun, or no keyring service (CI). */
	available(): Promise<boolean>;
};

/** All entries of this app share one service name in the credential store. */
const SERVICE = 'sap-test-lab';

type Entry = { service: string; name: string };
type BunSecrets = {
	get(options: Entry): Promise<string | null>;
	set(options: Entry & { value: string }): Promise<void>;
	delete(options: Entry): Promise<boolean>;
};

function bunSecrets(): BunSecrets | null {
	// The app's server runs on Bun, the unit tests on Node; `Bun` is not in the app's type roots.
	const bun: unknown = Reflect.get(globalThis, 'Bun');
	if (typeof bun !== 'object' || bun === null || !('secrets' in bun)) return null;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bun's API, typed above
	return bun.secrets as BunSecrets;
}

const missing = () => new Error('The system credential store is not available here.');

export function keychain(): SecretStore {
	const secrets = bunSecrets();
	return {
		async get(name) {
			try {
				return (await secrets?.get({ service: SERVICE, name })) ?? null;
			} catch {
				// No keyring service (headless Linux, CI): the app falls back to .env.
				return null;
			}
		},
		async set(name, value) {
			if (!secrets) throw missing();
			await secrets.set({ service: SERVICE, name, value });
		},
		async delete(name) {
			if (!secrets) throw missing();
			await secrets.delete({ service: SERVICE, name });
		},
		async available() {
			if (!secrets) return false;
			try {
				await secrets.get({ service: SERVICE, name: 'SAP_URL' });
				return true;
			} catch {
				return false;
			}
		}
	};
}
