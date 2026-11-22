// KI-generiert, geprüft von: <Name>
// spec: sap-tests/specs/shopping-cart-checkout-edge-cases.plan.md
// seed: sap-tests/tests/_agents/seed.spec.ts
// Covers SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo); needs internet access.
import { test, expect } from '../../../sap-plugin';
import { button, fillAndLeave, visible } from '../../../helpers/fiori';
import { openCart } from '../../../helpers/cart-demo';

const URL =
	'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark';
const CATEGORY = 'Laptops';
const PRODUCT = 'Notebook Basic 17';
const TOTAL_ONE = 'Total: 1.249,00 EUR';

const CARD_HOLDER = 'Alex Example';
const CARD_NUMBER = '1234567890123456';
const SECURITY_CODE = '123';
const EXPIRATION_DATE = '12/2030';

const STREET = 'Musterstrasse 1';
const CITY = 'Walldorf';
const ZIP_CODE = '69190';
const COUNTRY = 'Germany';

const FIRST_NAME = 'Alex';
const LAST_NAME = 'Example';
const PHONE = '+49 6227 000000';
const EMAIL = 'alex.example@example.com';

const NEW_PAYMENT_TYPE = 'Cash on Delivery';
const WARNING_TEXT =
	'Are you sure you want to change the payment type? This will discard your progress.';

test.describe('Shopping Cart checkout edge cases', () => {
	test('demo kit: "Yes" on the payment type warning cuts the wizard back to the payment type', async ({
		page
	}) => {
		// UI5 keeps the controls of wizard steps that are not shown: use the shown ones only.
		const step3 = visible(button(page, 'Step 3'));
		const step4 = visible(button(page, 'Step 4'));
		const step5 = visible(button(page, 'Step 5'));
		const warning = page.getByRoleUI5('Dialog', { title: 'Warning' });
		const wizardStep = (stepTitle: string) =>
			visible(page.getByRoleUI5('WizardStep', { title: stepTitle }));
		const field = (placeholder: string) => visible(page.getByRoleUI5('Input', { placeholder }));
		const firstName = field('Enter your first name');

		// 1. Open the address from the overview
		await page.goto(URL);
		await expect(page.getByRoleUI5('StandardListItem', { title: CATEGORY })).toBeVisible();

		// 2. Click the category
		await page.getByRoleUI5('StandardListItem', { title: CATEGORY }).click();

		// 3. Click the product
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

		// 7. Click "Step 2", then "Step 3"
		await button(page, 'Step 2').click();
		await button(page, 'Step 3').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Credit Card Details' })).toBeVisible();

		// 8. Fill the credit card details
		await fillAndLeave(
			page.getByRoleUI5('Input', { placeholder: 'Enter card holder name' }),
			CARD_HOLDER
		);
		await fillAndLeave(
			page.getByRoleUI5('MaskInput', { placeholder: 'Enter card number' }),
			CARD_NUMBER
		);
		await fillAndLeave(
			page.getByRoleUI5('MaskInput', { placeholder: 'Enter the 3-digits security number' }),
			SECURITY_CODE
		);
		await fillAndLeave(page.getByRoleUI5('DatePicker'), EXPIRATION_DATE);
		await expect(button(page, 'Step 4')).toBeVisible();

		// 9. Click "Step 4", then fill the invoice address
		await button(page, 'Step 4').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Invoice Address' })).toBeVisible();
		await fillAndLeave(field('Enter your street name and house number'), STREET);
		await fillAndLeave(field('Enter your city'), CITY);
		await fillAndLeave(field('Enter your zip code'), ZIP_CODE);
		await fillAndLeave(field('Enter your country'), COUNTRY);
		await expect(button(page, 'Step 5')).toBeVisible();

		// 10. Click "Cash on Delivery" in the step "Payment Type"
		await button(page, NEW_PAYMENT_TYPE).click();
		await expect(warning).toBeVisible();
		await expect(page.getByRoleUI5('Text', { text: WARNING_TEXT })).toBeVisible();

		// 11. Click "Yes"
		await page.getByRoleUI5('Button', { text: 'Yes' }, { exact: true }).click();
		await expect(warning).toBeHidden();
		await expect(
			page.getByRoleUI5('SegmentedButton', { selectedKey: NEW_PAYMENT_TYPE })
		).toBeVisible();
		await expect(step3).toBeVisible();
		await expect(wizardStep('Payment Type')).toBeVisible();
		await expect(wizardStep('Credit Card Details')).toBeHidden();
		await expect(wizardStep('Invoice Address')).toBeHidden();
		await expect(step4).toBeHidden();
		await expect(step5).toBeHidden();

		// 12. Click "Step 3"
		await step3.click();
		await expect(wizardStep('Details for Cash on Delivery')).toBeVisible();
		await expect(step4).toBeHidden();
		await expect(firstName).toHaveValue('');
		await expect(
			page.getByRoleUI5('Input', { placeholder: 'Enter your first name', valueState: 'Error' })
		).toBeHidden();

		// 13. Fill the cash on delivery details
		await fillAndLeave(firstName, FIRST_NAME);
		await fillAndLeave(field('Enter your last name'), LAST_NAME);
		await fillAndLeave(field('Enter your phone number'), PHONE);
		await fillAndLeave(field('Enter your email address'), EMAIL);
		await expect(step4).toBeVisible();

		// 14. Click "Step 4": the address from before is still there and "Step 5" needs no new input
		await step4.click();
		await expect(wizardStep('Invoice Address')).toBeVisible();
		await expect(field('Enter your street name and house number')).toHaveValue(STREET);
		await expect(field('Enter your city')).toHaveValue(CITY);
		await expect(field('Enter your zip code')).toHaveValue(ZIP_CODE);
		await expect(field('Enter your country')).toHaveValue(COUNTRY);
		await expect(step5).toBeVisible();
	});
});
