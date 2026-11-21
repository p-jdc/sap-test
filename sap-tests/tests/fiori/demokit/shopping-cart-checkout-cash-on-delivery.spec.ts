// KI-generiert, geprüft von: <Name>
// spec: sap-tests/specs/shopping-cart-checkout.plan.md
// seed: sap-tests/tests/_agents/seed.spec.ts
// Covers SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo); needs internet access.
import { test, expect, type Page } from '../../../sap-plugin';
import { button, fillAndLeave, title, visible } from '../../../helpers/fiori';
import { openCart } from '../../../helpers/cart-demo';

const URL =
	'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark';
const CATEGORY = 'Laptops';
const PRODUCT = 'Notebook Basic 17';
const TOTAL_ONE = 'Total: 1.249,00 EUR';

const FIRST_NAME = 'Alex';
const LAST_NAME = 'Example';
const PHONE = '+49 6227 000000';
const EMAIL = 'alex.example@example.com';

const INVOICE = {
	street: 'Musterstrasse 1',
	city: 'Walldorf',
	zipCode: '69190',
	country: 'Germany'
};
const SHIPPING = {
	street: 'Beispielweg 2',
	city: 'Heidelberg',
	zipCode: '69115',
	country: 'Germany'
};

const STREET_FIELD = 'Enter your street name and house number';
const CITY_FIELD = 'Enter your city';
const ZIP_CODE_FIELD = 'Enter your zip code';
const COUNTRY_FIELD = 'Enter your country';

// The address inputs exist twice, for the invoice and for the shipping address. Only the shown
// ones count; on the step "Shipping Address" both forms are shown and the shipping one is the last.
const addressField = (page: Page, placeholder: string) =>
	visible(page.getByRoleUI5('Input', { placeholder })).last();

test.describe('Shopping Cart checkout', () => {
	test('demo kit: check out with cash on delivery, a different shipping address and express delivery', async ({
		page
	}) => {
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

		// 8. Click "Cash on Delivery"
		await button(page, 'Cash on Delivery').click();
		await expect(
			page.getByRoleUI5('SegmentedButton', { selectedKey: 'Cash on Delivery' })
		).toBeVisible();

		// 9. Click "Step 3"
		await button(page, 'Step 3').click();
		await expect(
			page.getByRoleUI5('WizardStep', { title: 'Details for Cash on Delivery' })
		).toBeVisible();
		await expect(button(page, 'Step 4')).toBeHidden();

		// 10. Fill the first name
		await fillAndLeave(
			page.getByRoleUI5('Input', { placeholder: 'Enter your first name' }),
			FIRST_NAME
		);

		// 11. Fill the last name
		await fillAndLeave(
			page.getByRoleUI5('Input', { placeholder: 'Enter your last name' }),
			LAST_NAME
		);

		// 12. Fill the phone number
		await fillAndLeave(
			page.getByRoleUI5('Input', { placeholder: 'Enter your phone number' }),
			PHONE
		);

		// 13. Fill the e-mail address
		await fillAndLeave(
			page.getByRoleUI5('Input', { placeholder: 'Enter your email address' }),
			EMAIL
		);
		await expect(button(page, 'Step 4')).toBeVisible();

		// 14. Click "Step 4"
		await button(page, 'Step 4').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Invoice Address' })).toBeVisible();

		// 15. Tick "Use Different Address for Delivery"
		const differentAddress = page.getByRoleUI5('CheckBox');
		// click(), not check(): check() fails on this control with "Clicking the checkbox did not change
		// its state". Why was not looked into.
		await differentAddress.click();
		await expect(differentAddress).toBeChecked();

		// 16. - 19. Fill the invoice address
		await fillAndLeave(addressField(page, STREET_FIELD), INVOICE.street);
		await fillAndLeave(addressField(page, CITY_FIELD), INVOICE.city);
		await fillAndLeave(addressField(page, ZIP_CODE_FIELD), INVOICE.zipCode);
		await fillAndLeave(addressField(page, COUNTRY_FIELD), INVOICE.country);
		await expect(button(page, 'Step 5')).toBeVisible();

		// 20. Click "Step 5"
		await button(page, 'Step 5').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Shipping Address' })).toBeVisible();
		await expect(button(page, 'Step 6')).toBeHidden();

		// 21. Fill the shipping address
		await fillAndLeave(addressField(page, STREET_FIELD), SHIPPING.street);
		await fillAndLeave(addressField(page, CITY_FIELD), SHIPPING.city);
		await fillAndLeave(addressField(page, ZIP_CODE_FIELD), SHIPPING.zipCode);
		await fillAndLeave(addressField(page, COUNTRY_FIELD), SHIPPING.country);
		await expect(button(page, 'Step 6')).toBeVisible();

		// 22. Click "Step 6"
		await button(page, 'Step 6').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Delivery Type' })).toBeVisible();

		// 23. Click "Express"
		await button(page, 'Express').click();
		await expect(
			page.getByRoleUI5('SegmentedButton', { selectedKey: 'Express Delivery' })
		).toBeVisible();

		// 24. Click "Order Summary"
		await button(page, 'Order Summary').click();
		await expect(button(page, 'Submit')).toBeVisible();
		await expect(title(page, 'Cash on Delivery')).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: EMAIL })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: PHONE })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: INVOICE.street })).toBeVisible();
		await expect(
			page.getByRoleUI5('Text', { text: 'Express Delivery' }, { exact: true })
		).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: SHIPPING.street })).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: SHIPPING.city })).toBeVisible();
		await expect(
			visible(page.getByRoleUI5('Text', { text: 'Same as invoice address' }))
		).toBeHidden();

		// 25. Click "Submit"
		await button(page, 'Submit').click();
		await expect(page.getByRoleUI5('Dialog', { title: 'Confirmation' })).toBeVisible();
		await expect(
			page.getByRoleUI5('Text', { text: 'Are you sure you want to submit your order?' })
		).toBeVisible();

		// 26. Click "Yes"
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
	});
});
