// Shared steps for SAP's public UI5 demo kit app "Shopping Cart" (tests/fiori/demokit/shopping-cart*).
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { title, visible } from './fiori';

const CART_ICON = 'sap-icon://cart';

/**
 * Opens the cart. Every view has its own cart toggle; during a page transition the old one is
 * still visible, so this waits until exactly one is left before clicking it.
 */
export async function openCart(page: Page) {
	const cartToggle = visible(page.getByRoleUI5('ToggleButton', { icon: CART_ICON }));
	await expect(cartToggle).toHaveCount(1);
	await cartToggle.click();
	await expect(title(page, 'Shopping Cart')).toBeVisible();
}
