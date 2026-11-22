import { describe, expect, test } from 'vitest';
import { lineSplitter } from './lines.js';

describe('lineSplitter', () => {
	test('joins a line that arrives in two chunks', () => {
		const lines: string[] = [];
		const s = lineSplitter((l) => {
			lines.push(l);
		});
		s.push('first\nsec');
		expect(lines).toEqual(['first']);
		s.push('ond\n');
		expect(lines).toEqual(['first', 'second']);
	});

	test('flush hands out a last line without a newline, once', () => {
		const lines: string[] = [];
		const s = lineSplitter((l) => {
			lines.push(l);
		});
		s.push('done\n1 passed');
		s.flush();
		s.flush();
		expect(lines).toEqual(['done', '1 passed']);
	});
});
