import { expect, test } from 'vitest';
import { allowsCredentials, sameOrigin } from './origin.js';

test('sameOrigin compares scheme, host and port, not the path', () => {
	expect(sameOrigin('https://sap.example.com/a', 'https://sap.example.com/b?c')).toBe(true);
	expect(sameOrigin('https://sap.example.com', 'http://sap.example.com')).toBe(false);
	expect(sameOrigin('https://sap.example.com:8443', 'https://sap.example.com')).toBe(false);
	expect(sameOrigin('https://sap.example.com.evil.test', 'https://sap.example.com')).toBe(false);
	expect(sameOrigin('not a url', 'https://sap.example.com')).toBe(false);
});

test('credentials go over https, or over http only to this computer', () => {
	const allowed = [
		'https://sap.example.com/fiori',
		'http://localhost:4999/',
		'http://lab.localhost/',
		'http://127.0.0.1:8080/',
		'http://127.5.6.7/',
		'http://[::1]:3000/'
	];
	const refused = [
		'http://sap.example.com/fiori',
		'http://10.0.0.5/',
		'http://127.0.0.1.evil.test/',
		'http://localhost.evil.test/',
		'ftp://sap.example.com/',
		'not a url'
	];
	expect(allowed.filter((url) => !allowsCredentials(url))).toEqual([]);
	expect(refused.filter((url) => allowsCredentials(url))).toEqual([]);
});
