import { afterEach, describe, expect, test, vi } from 'vitest';
import { keychain } from './secret-store.js';

afterEach(() => {
	vi.unstubAllGlobals();
});

const fail = () => Promise.reject(new Error('no keyring service'));

describe('keychain', () => {
	test('without Bun there is no store: reads are empty, writes say why', async () => {
		vi.stubGlobal('Bun', null);
		const store = keychain();
		expect(await store.available()).toBe(false);
		expect(await store.get('SAP_URL')).toBeNull();
		await expect(store.set('SAP_URL', 'x')).rejects.toThrow('not available');
		await expect(store.delete('SAP_URL')).rejects.toThrow('not available');
	});

	test("keeps every entry under the app's service name", async () => {
		const entries = new Map<string, string>();
		vi.stubGlobal('Bun', {
			secrets: {
				get: ({ service, name }: { service: string; name: string }) =>
					Promise.resolve(entries.get(`${service}/${name}`)),
				set: ({ service, name, value }: { service: string; name: string; value: string }) => {
					entries.set(`${service}/${name}`, value);
					return Promise.resolve();
				},
				delete: ({ service, name }: { service: string; name: string }) =>
					Promise.resolve(entries.delete(`${service}/${name}`))
			}
		});
		const store = keychain();
		expect(await store.available()).toBe(true);
		await store.set('SAP_PASSWORD', 'pw');
		expect([...entries]).toEqual([['sap-test-lab/SAP_PASSWORD', 'pw']]);
		expect(await store.get('SAP_PASSWORD')).toBe('pw');
		await store.delete('SAP_PASSWORD');
		expect(await store.get('SAP_PASSWORD')).toBeNull();
	});

	test('a store that cannot be reached reads as empty and unavailable', async () => {
		vi.stubGlobal('Bun', { secrets: { get: fail, set: fail, delete: fail } });
		const store = keychain();
		expect(await store.get('SAP_URL')).toBeNull();
		expect(await store.available()).toBe(false);
		await expect(store.set('SAP_URL', 'x')).rejects.toThrow('no keyring service');
	});
});
