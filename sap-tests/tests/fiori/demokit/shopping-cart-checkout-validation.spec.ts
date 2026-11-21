// KI-generiert, geprüft von: <Name>
// spec: sap-tests/specs/shopping-cart-checkout.plan.md
// seed: sap-tests/tests/_agents/seed.spec.ts
// Covers SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo); needs internet access.
import { test, expect } from '../../../sap-plugin';
import { button, fillAndLeave } from '../../../helpers/fiori';
import { openCart } from '../../../helpers/cart-demo';

const URL =
	'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark';
const CATEGORY = 'Laptops';
const PRODUCT = 'Notebook Basic 17';
const TOTAL_ONE = 'Total: 1.249,00 EUR';

const CARD_HOLDER_FIELD = 'Enter card holder name';
const CARD_NUMBER_FIELD = 'Enter card number';
const SECURITY_CODE_FIELD = 'Enter the 3-digits security number';

const CARD_HOLDER = 'Alex Example';
const CARD_NUMBER = '1234567890123456';
const SECURITY_CODE = '123';
const EXPIRATION_DATE = '12/2030';

const CARD_HOLDER_TOO_SHORT = 'Al';
const CARD_NUMBER_INCOMPLETE = '1234';
const CARD_NUMBER_INCOMPLETE_SHOWN = '1234-____-____-____';
const SECURITY_CODE_INCOMPLETE = '1';

const TOO_SHORT_MESSAGE = 'Enter a value with at least 3 characters';
const INVALID_MESSAGE = 'Enter a valid value';

test.describe('Shopping Cart checkout', () => {
	test('demo kit: the credit card step only lets valid details through', async ({ page }) => {
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

		// 7. Click "Step 2", then "Step 3"
		await button(page, 'Step 2').click();
		await button(page, 'Step 3').click();
		await expect(page.getByRoleUI5('WizardStep', { title: 'Credit Card Details' })).toBeVisible();
		await expect(button(page, 'Step 4')).toBeHidden();

		const cardHolder = page.getByRoleUI5('Input', { placeholder: CARD_HOLDER_FIELD });
		const cardNumber = page.getByRoleUI5('MaskInput', { placeholder: CARD_NUMBER_FIELD });
		const securityCode = page.getByRoleUI5('MaskInput', { placeholder: SECURITY_CODE_FIELD });
		// An untouched field shows no error.
		await expect(
			page.getByRoleUI5('Input', { placeholder: CARD_HOLDER_FIELD, valueState: 'Error' })
		).toBeHidden();

		// 8. Fill a card holder's name that is too short
		await fillAndLeave(cardHolder, CARD_HOLDER_TOO_SHORT);
		await expect(
			page.getByRoleUI5('Input', {
				placeholder: CARD_HOLDER_FIELD,
				valueState: 'Error',
				valueStateText: TOO_SHORT_MESSAGE
			})
		).toBeVisible();

		// 9. Fill an incomplete card number
		await fillAndLeave(cardNumber, CARD_NUMBER_INCOMPLETE);
		await expect(cardNumber).toHaveValue(CARD_NUMBER_INCOMPLETE_SHOWN);
		await expect(
			page.getByRoleUI5('MaskInput', {
				placeholder: CARD_NUMBER_FIELD,
				valueState: 'Error',
				valueStateText: INVALID_MESSAGE
			})
		).toBeVisible();

		// 10. Fill an incomplete security code
		await fillAndLeave(securityCode, SECURITY_CODE_INCOMPLETE);
		await expect(
			page.getByRoleUI5('MaskInput', {
				placeholder: SECURITY_CODE_FIELD,
				valueState: 'Error',
				valueStateText: INVALID_MESSAGE
			})
		).toBeVisible();
		await expect(button(page, 'Step 4')).toBeHidden();

		// 11. Correct the three fields and fill the expiration date
		await fillAndLeave(cardHolder, CARD_HOLDER);
		await fillAndLeave(cardNumber, CARD_NUMBER);
		await fillAndLeave(securityCode, SECURITY_CODE);
		await fillAndLeave(page.getByRoleUI5('DatePicker'), EXPIRATION_DATE);
		await expect(button(page, 'Step 4')).toBeVisible();
		await expect(
			page.getByRoleUI5('Input', { placeholder: CARD_HOLDER_FIELD, valueState: 'None' })
		).toBeVisible();
		await expect(
			page.getByRoleUI5('MaskInput', { placeholder: CARD_NUMBER_FIELD, valueState: 'None' })
		).toBeVisible();

		// 12. Clear the card holder's name
		await fillAndLeave(cardHolder, '');
		await expect(button(page, 'Step 4')).toBeHidden();

		// 13. Fill it again
		await fillAndLeave(cardHolder, CARD_HOLDER);
		await expect(button(page, 'Step 4')).toBeVisible();

		// 14. Click "Cash on Delivery" in the step "Payment Type"
		await button(page, 'Cash on Delivery').click();
		await expect(page.getByRoleUI5('Dialog', { title: 'Warning' })).toBeVisible();
		await expect(
			page.getByRoleUI5('Text', {
				text: 'Are you sure you want to change the payment type? This will discard your progress.'
			})
		).toBeVisible();
	});
});
