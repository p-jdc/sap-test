import { expect, test } from 'vitest';
import { settingProblem } from './setting-value.js';

test('a URL setting must be a full URL', () => {
	expect(settingProblem('SAP_URL', 'sap.example.com')).toMatch(/full URL/);
	expect(settingProblem('SAP_URL', 'https://sap.example.com/fiori?sap-client=100')).toBeUndefined();
});

test('an address must use https, except on this computer', () => {
	for (const name of ['SAP_URL', 'ARIBA_URL', 'SAP_API_URL'])
		expect(settingProblem(name, 'http://sap.example.com')).toMatch(/must start with https:\/\//);
	expect(settingProblem('SAP_API_URL', 'http://127.0.0.1:4010')).toBeUndefined();
	expect(settingProblem('SAP_URL', 'http://localhost:4999/launchpad')).toBeUndefined();
});

test('the API address is a host without a path, because the clients add the service path', () => {
	expect(settingProblem('SAP_API_URL', 'https://sap.example.com')).toBeUndefined();
	expect(settingProblem('SAP_API_URL', 'https://sap.example.com:44300/')).toBeUndefined();
	expect(settingProblem('SAP_API_URL', 'https://sap.example.com/sap/opu/odata')).toBe(
		'SAP_API_URL must be the host only, without a path: https://sap.example.com'
	);
	expect(settingProblem('SAP_API_URL', 'https://sap.example.com/?sap-client=100')).toMatch(
		/host only/
	);
});

test('the SAP client is three digits', () => {
	expect(settingProblem('SAP_CLIENT', '002')).toBeUndefined();
	expect(settingProblem('SAP_CLIENT', '2')).toMatch(/three digits/);
	expect(settingProblem('SAP_CLIENT', 'abc')).toMatch(/three digits/);
});

test('other settings take any value', () => {
	expect(settingProblem('SAP_API_USERNAME', 'ANY USER')).toBeUndefined();
});
