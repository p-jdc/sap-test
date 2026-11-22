// Read by tests/_plugin/lint-rules.spec.ts like passwords.ts.
import { expect, test } from '@playwright/test'; // expect: eslint(no-restricted-imports) eslint(no-restricted-imports)
import type { Page } from '@playwright/test';
import { chromium } from '@playwright/test';

test('fixture', ({ page }: { page: Page }) => {
	expect(page).toBeTruthy();
	expect(chromium).toBeTruthy();
});
