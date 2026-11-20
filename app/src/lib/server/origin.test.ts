import { expect, test } from 'vitest';
import { sameOrigin } from './origin.js';

test('sameOrigin compares scheme, host and port, not the path', () => {
	expect(sameOrigin('https://sap.example.com/a', 'https://sap.example.com/b?c')).toBe(true);
	expect(sameOrigin('https://sap.example.com', 'http://sap.example.com')).toBe(false);
	expect(sameOrigin('https://sap.example.com:8443', 'https://sap.example.com')).toBe(false);
	expect(sameOrigin('https://sap.example.com.evil.test', 'https://sap.example.com')).toBe(false);
	expect(sameOrigin('not a url', 'https://sap.example.com')).toBe(false);
});
