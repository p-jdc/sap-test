import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// paths.ts reads TEST_APP_DATA_DIR and SAP_TESTS_DIR when it is first imported.
type Review = typeof import('./healer-review.js');
let review: Review;
let data = '';
let tests = '';
const OWNER = { runId: '20260101-000001-abcd', testId: 'abc-def', title: 'creates an order' };

beforeEach(async () => {
	data = mkdtempSync(join(tmpdir(), 'review-data-'));
	tests = mkdtempSync(join(tmpdir(), 'review-tests-'));
	mkdirSync(join(tests, 'tests'), { recursive: true });
	vi.stubEnv('TEST_APP_DATA_DIR', data);
	vi.stubEnv('SAP_TESTS_DIR', tests);
	vi.resetModules();
	review = await import('./healer-review.js');
});

const file = (name: string) => join(tests, 'tests', name);

/** The healer changes a file, as the gate and the hook after the tool record it. */
function healerWrites(abs: string, content: string) {
	review.beforeChange(OWNER, abs);
	writeFileSync(abs, content);
	review.afterChange();
}

describe('the record of unread repairs', () => {
	test('blocks test code from the first change until the repair is settled', () => {
		writeFileSync(file('a.spec.ts'), 'before');
		expect(review.reviewBlock()).toBeUndefined();
		review.beforeChange(OWNER, file('a.spec.ts'));
		// During the change, and if the app stops in it, what the file will hold is unknown.
		writeFileSync(file('a.spec.ts'), 'half');
		expect(review.unreviewed()).toMatchObject({
			...OWNER,
			files: [expect.stringMatching(/a\.spec\.ts$/)]
		});
		review.afterChange();
		expect(review.reviewBlock()).toMatch(/"creates an order".*has not been read/);

		// Another repair's settling does not count.
		review.settleRepair(OWNER.runId, 'another-test');
		expect(review.unreviewed()).not.toBeNull();
		review.settleRepair(OWNER.runId, OWNER.testId);
		expect(review.reviewBlock()).toBeUndefined();
	});

	test('counts a file the healer created', () => {
		healerWrites(file('new.spec.ts'), 'new');
		expect(review.unreviewed()?.files).toEqual([expect.stringMatching(/new\.spec\.ts$/)]);
	});

	test('a file a person changed since, or that is as before, no longer counts', () => {
		writeFileSync(file('a.spec.ts'), 'before');
		writeFileSync(file('b.spec.ts'), 'before');
		healerWrites(file('a.spec.ts'), 'healer');
		healerWrites(file('b.spec.ts'), 'healer');
		writeFileSync(file('a.spec.ts'), 'a person changed it');
		expect(review.unreviewed()?.files).toEqual([expect.stringMatching(/b\.spec\.ts$/)]);
		writeFileSync(file('b.spec.ts'), 'before');
		expect(review.unreviewed()).toBeNull();
	});

	test('a further change of a counted file still counts', () => {
		writeFileSync(file('a.spec.ts'), 'before');
		healerWrites(file('a.spec.ts'), 'one');
		healerWrites(file('a.spec.ts'), 'two');
		expect(review.unreviewed()?.files).toHaveLength(1);
	});

	test('a record that cannot be read blocks everything and is not removed by settling', () => {
		writeFileSync(join(data, 'healer-unreviewed.json'), '{ broken');
		expect(review.reviewBlock()).toMatch(/cannot be read, so no test code runs/);
		review.settleRepair(OWNER.runId, OWNER.testId);
		expect(existsSync(join(data, 'healer-unreviewed.json'))).toBe(true);
		expect(() => review.unreviewed()).toThrow(SyntaxError);
	});

	test('ignores entries outside the test project', () => {
		const outside = join(mkdtempSync(join(tmpdir(), 'review-outside-')), 'x.ts');
		writeFileSync(
			join(data, 'healer-unreviewed.json'),
			JSON.stringify({ ...OWNER, files: { [outside]: { before: null } } })
		);
		writeFileSync(outside, 'x');
		expect(review.unreviewed()).toBeNull();
	});
});
