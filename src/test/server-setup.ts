import { vi } from 'vitest';
import type { SecretStore } from '#lib/server/secret-store.js';

// The server tests run on Bun, like the app, where Bun.secrets is the real credential store of
// this computer (the macOS Keychain). No test reads or writes it: the store is empty and cannot be
// written. secret-store.test.ts tests the real module with stand-ins for Bun's API.
vi.mock('#lib/server/secret-store.js', () => ({
	keychain: (): SecretStore => ({
		get: () => Promise.resolve(null),
		set: () => Promise.reject(new Error('No credential store in tests.')),
		delete: () => Promise.reject(new Error('No credential store in tests.')),
		available: () => Promise.resolve(false)
	})
}));
