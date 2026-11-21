// KI-generiert, geprüft von: <Name>
// spec: sap-tests/specs/shopping-cart-checkout.plan.md
// seed: sap-tests/tests/_agents/seed.spec.ts
// Covers SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo); needs internet access.
import { test, expect, type Locator, type Page } from '../../../sap-plugin';
import { button, title } from '../../../helpers/fiori';

const URL =
	'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark';
const CATEGORY = 'Laptops';
const PRODUCT = 'Notebook Basic 17';
const TOTAL_EMPTY = 'Total: 0,00 EUR';
const TOTAL_ONE = 'Total: 1.249,00 EUR';
const CART_ICON = 'sap-icon://cart';

const CARD_HOLDER = 'Alex Example';
const CARD_NUMBER = '1234567890123456';
const CARD_NUMBER_SHOWN = '1234-5678-9012-3456';
const SECURITY_CODE = '123';
const EXPIRATION_DATE = '12/2030';

const STREET = 'Musterstrasse 1';
const CITY = 'Walldorf';
const ZIP_CODE = '69190';
const COUNTRY = 'Germany';

// Controls of views and wizard steps that are not shown stay in the page, so some locators match
// a hidden twin as well (the address inputs exist for the invoice and for the shipping address).
const visible = (locator: Locator) => locator.filter({ visible: true });

// Every view has its own cart toggle; during a page transition the old one is still visible,
// so wait until exactly one is left before clicking it.
async function openCart(page: Page) {
	const cartToggle = visible(page.getByRoleUI5('ToggleButton', { icon: CART_ICON }));
	await expect(cartToggle).toHaveCount(1);
	await cartToggle.click();
	await expect(title(page, 'Shopping Cart')).toBeVisible();
}

// A field of the wizard is validated when it loses focus.
async function fillAndLeave(field: Locator, value: string) {
	await field.fill(value);
	await field.press('Tab');
}

test.describe('Shopping Cart checkout', () => {
	test('demo kit: check out with credit card and standard delivery', async ({ page }) => {
		// 1. Open the address above
		await page.goto(URL);
		await expect(page.getByRoleUI5('StandardListItem', { title: CATEGORY })).toBeVisible();

		// 2. Open the category
		await page.getByRoleUI5('StandardListItem', { title: CATEGORY }).click();

		// 3. Open the product
		await page.getByRoleUI5('Text', { text: PRODUCT }).click();
		await expect(page.getByRoleUI5('ObjectHeader', { title: PRODUCT })).toBeVisible();

		// 4. Open the cart
		await openCart(page);

		// 5. Click "Add to Cart"
		await button(page, 'Add to Cart').click();
		await expect(page.getByRoleUI5('ObjectListItem', { intro: '1 x' })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: TOTAL_ONE })).toBeVisible();

		// 6. Click "Proceed"
		await button(page, 'Proceed').click();
		await expect(page.getByRoleUI5('Page', { title: 'Checkout' })).toBeVisible();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Items' })).toBeVisible();

		// 7. Click "Step 2"
		await button(page, 'Step 2').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Payment Type' })).toBeVisible();
		await expect(
			page.getByRoleUI5('SegmentedButton', { selectedKey: 'Credit Card' })
		).toBeVisible();

		// 8. Click "Step 3"
		await button(page, 'Step 3').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Credit Card Details' })).toBeVisible();
		await expect(button(page, 'Step 4')).toBeHidden();

		// 9. Fill the card holder's name
		await fillAndLeave(
			page.getByRoleUI5('Input', { placeholder: 'Enter card holder name' }),
			CARD_HOLDER
		);

		// 10. Fill the card number. The field is masked: fill() works, typing loses the first digit.
		const cardNumber = page.getByRoleUI5('MaskInput', { placeholder: 'Enter card number' });
		await fillAndLeave(cardNumber, CARD_NUMBER);
		await expect(cardNumber).toHaveValue(CARD_NUMBER_SHOWN);

		// 11. Fill the security code
		await fillAndLeave(
			page.getByRoleUI5('MaskInput', { placeholder: 'Enter the 3-digits security number' }),
			SECURITY_CODE
		);

		// 12. Fill the expiration date
		await fillAndLeave(page.getByRoleUI5('DatePicker'), EXPIRATION_DATE);
		await expect(button(page, 'Step 4')).toBeVisible();

		// 13. Click "Step 4"
		await button(page, 'Step 4').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Invoice Address' })).toBeVisible();

		// 14. Fill the street
		await fillAndLeave(
			visible(
				page.getByRoleUI5('Input', { placeholder: 'Enter your street name and house number' })
			),
			STREET
		);

		// 15. Fill the city
		await fillAndLeave(
			visible(page.getByRoleUI5('Input', { placeholder: 'Enter your city' })),
			CITY
		);

		// 16. Fill the zip code
		await fillAndLeave(
			visible(page.getByRoleUI5('Input', { placeholder: 'Enter your zip code' })),
			ZIP_CODE
		);

		// 17. Fill the country
		await fillAndLeave(
			visible(page.getByRoleUI5('Input', { placeholder: 'Enter your country' })),
			COUNTRY
		);
		await expect(button(page, 'Step 5')).toBeVisible();

		// 18. Click "Step 5"
		await button(page, 'Step 5').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Delivery Type' })).toBeVisible();
		await expect(
			page.getByRoleUI5('SegmentedButton', { selectedKey: 'Standard Delivery' })
		).toBeVisible();

		// 19. Click "Order Summary"
		await button(page, 'Order Summary').click();
		await expect(button(page, 'Submit')).toBeVisible();
		await expect(title(page, TOTAL_ONE)).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: 'Credit Card' }, { exact: true })).toBeVisible();
		await expect(title(page, 'Credit Card Payment')).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: CARD_HOLDER })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: CARD_NUMBER_SHOWN })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: EXPIRATION_DATE })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: STREET })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: CITY })).toBeVisible();
		await expect(
			page.getByRoleUI5('Text', { text: 'Standard Delivery' }, { exact: true })
		).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: 'Same as invoice address' })).toBeVisible();

		// 20. Click "Submit"
		await button(page, 'Submit').click();
		await expect(page.getByRoleUI5('Dialog', { title: 'Confirmation' })).toBeVisible();
		await expect(
			page.getByRoleUI5('Text', { text: 'Are you sure you want to submit your order?' })
		).toBeVisible();

		// 21. Click "Yes"
		await button(page, 'Yes').click();
		await expect(page.getByRoleUI5('Page', { title: 'Order Completed' })).toBeVisible();
		// getByRoleUI5 resolves a FormattedText to the link inside it; 'root' takes the whole control.
		const confirmation = page.locateUI5Control({
			controlType: 'sap.m.FormattedText',
			interaction: 'root'
		});
		await expect(confirmation).toContainText('Thank you for your order!');
		await expect(confirmation).toContainText('Your order number:');
		await expect(confirmation).toContainText('You will receive an e-mail confirmation shortly.');

		// 22. Click "Return to Shop", then open the cart
		await visible(button(page, 'Return to Shop')).click();
		await openCart(page);
		await expect(visible(page.getByRoleUI5('Text', { text: TOTAL_EMPTY }))).toBeVisible();
		await expect(button(page, 'Proceed')).toBeDisabled();
	});
});
