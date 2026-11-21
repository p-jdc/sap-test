import { describe, expect, test } from 'vitest';
import { redactor } from './redact.js';

describe('redactor', () => {
	test('masks every secret in strings, arrays and objects, but not in keys', () => {
		const redact = redactor(['pw', 'pw-long']);
		expect(redact('Fill "pw-long" then "pw"')).toBe('Fill "***" then "***"');
		expect(
			redact({ pw: ['a pw', { title: 'pw-long' }], count: 2, none: null, flag: true })
		).toEqual({ pw: ['a ***', { title: '***' }], count: 2, none: null, flag: true });
	});

	test('leaves values alone without secrets, and ignores empty ones', () => {
		const value = { title: 'Fill "x"' };
		expect(redactor([])(value)).toBe(value);
		expect(redactor([''])('text')).toBe('text');
	});
});
