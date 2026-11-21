import { describe, expect, test, vi } from 'vitest';

// The server tests replace this module with an empty store (src/test/server-setup.ts).
const { keychain } = await vi.importActual<typeof import('./secret-store.js')>('./secret-store.js');

const fail = () => Promise.reject(new Error('no keyring service'));

describe('keychain', () => {
	test('without a credential store there is none: reads are empty, writes say why', async () => {
		const store = keychain(null);
		expect(await store.available()).toBe(false);
		expect(await store.get('SAP_URL')).toBeNull();
		await expect(store.set('SAP_URL', 'x')).rejects.toThrow('not available');
		await expect(store.delete('SAP_URL')).rejects.toThrow('not available');
	});

	test("keeps every entry under the app's service name", async () => {
		const entries = new Map<string, string>();
		const store = keychain({
			get: ({ service, name }) => Promise.resolve(entries.get(`${service}/${name}`)),
			set: ({ service, name, value }) => {
				entries.set(`${service}/${name}`, value);
				return Promise.resolve();
			},
			delete: ({ service, name }) => Promise.resolve(entries.delete(`${service}/${name}`))
		});
		expect(await store.available()).toBe(true);
		await store.set('SAP_PASSWORD', 'pw');
		expect([...entries]).toEqual([['sap-test-lab/SAP_PASSWORD', 'pw']]);
		expect(await store.get('SAP_PASSWORD')).toBe('pw');
		await store.delete('SAP_PASSWORD');
		expect(await store.get('SAP_PASSWORD')).toBeNull();
	});

	test('a store that cannot be reached reads as empty and unavailable', async () => {
		const store = keychain({ get: fail, set: fail, delete: fail });
		expect(await store.get('SAP_URL')).toBeNull();
		expect(await store.available()).toBe(false);
		await expect(store.set('SAP_URL', 'x')).rejects.toThrow('no keyring service');
	});
});
