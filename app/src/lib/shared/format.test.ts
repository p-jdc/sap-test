import { describe, expect, test } from 'vitest';
import { kindLabel } from './format.js';

describe('kindLabel', () => {
	test('names the technology, or for other tests the system they sign in to', () => {
		expect(kindLabel('fiori', 'SAP test system')).toBe('Fiori / UI5');
		expect(kindLabel('webgui')).toBe('SAP WebGUI');
		expect(kindLabel('other', 'SAP Ariba')).toBe('SAP Ariba');
		expect(kindLabel('other')).toBe('Other');
	});
});
