import { expect, test } from 'vitest';
import { configuredHosts, hostAllowed } from './host-check.js';

test.each([
	'localhost',
	'localhost:4180',
	'LOCALHOST:5180',
	'localhost.',
	'app.localhost:3000',
	'127.0.0.1:3000',
	'192.168.1.20:3000',
	'[::1]:3000'
])('answers to %s', (host) => {
	expect(hostAllowed(host)).toBe(true);
});

test.each([
	['a name that was pointed at this machine', 'evil.example:4180'],
	['a name that only starts like localhost', 'localhost.evil.example'],
	['a name that only ends like localhost', 'notlocalhost'],
	['a name that looks like an address', '127.0.0.1.evil.example'],
	['no host at all', null],
	['an empty host', ''],
	['something that is not a host', 'a b/c']
])('refuses %s', (_what, host) => {
	expect(hostAllowed(host)).toBe(false);
});

test('answers to the names configured for a shared installation', () => {
	const allowed = configuredHosts(' Lab.Example.com, sap-lab ,');
	expect(allowed).toEqual(['lab.example.com', 'sap-lab']);
	expect(hostAllowed('lab.example.com:443', allowed)).toBe(true);
	expect(hostAllowed('SAP-LAB', allowed)).toBe(true);
	expect(hostAllowed('other.example.com', allowed)).toBe(false);
	expect(configuredHosts('')).toEqual([]);
});
