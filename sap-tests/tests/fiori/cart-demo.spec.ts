import { test } from '../../sap-plugin';

test('cart demo', async ({ page }) => {
	await page.goto('https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html');
	await page
		.locateUI5Control({
			controlType: 'sap.m.Image',
			viewName: 'sap.ui.demo.cart.view.Welcome',
			viewId: 'container-cart---welcomeView',
			bindingPath: { path: '/Promoted/1', propertyPath: 'Product/PictureUrl', modelName: 'view' }
		})
		.click();
	await page
		.locateUI5Control({
			controlType: 'sap.m.Button',
			viewName: 'sap.ui.demo.cart.view.Product',
			viewId: 'container-cart---product',
			i18NText: { propertyName: 'text', key: 'addToCartShort' },
			interaction: { idSuffix: 'content' }
		})
		.click();
	await page
		.locateUI5Control({
			controlType: 'sap.ui.core.Icon',
			viewName: 'sap.ui.demo.cart.view.Product',
			viewId: 'container-cart---product',
			properties: { src: { regex: { source: 'cart' } } }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---cartView--proceedButton',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--contentsStep-nextButton',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page.locateUI5Control({ id: 'container-cart---checkoutView--payViaCOD-button' }).click();
	await page.locateUI5Control({ id: 'container-cart---checkoutView--payViaCC-button' }).click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--paymentTypeStep-nextButton',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--creditCardHolderName',
			interaction: { idSuffix: 'inner' }
		})
		.fill('sdf');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--creditCardNumber',
			interaction: { idSuffix: 'inner' }
		})
		.fill('2343-4234-3423-4234');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--creditCardSecurityNumber',
			interaction: { idSuffix: 'inner' }
		})
		.fill('234');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--creditCardExpirationDate',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({ id: 'container-cart---checkoutView--creditCardExpirationDate-icon' })
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--creditCardExpirationDate-cal--Month0',
			searchOpenDialogs: true,
			interaction: { idSuffix: '20261208' }
		})
		.click({ force: true });
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--creditCardStep-nextButton',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressAddress',
			interaction: { idSuffix: 'inner' }
		})
		.fill('wewrwer');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressCity',
			interaction: { idSuffix: 'inner' }
		})
		.fill('werer');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressZip',
			interaction: { idSuffix: 'inner' }
		})
		.fill('324');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressCountry',
			interaction: { idSuffix: 'inner' }
		})
		.fill('sfdfsdf');
	await page
		.locateUI5Control({
			controlType: 'sap.ui.layout.Grid',
			viewName: 'sap.ui.demo.cart.view.Checkout',
			viewId: 'container-cart---checkoutView',
			ancestor: { id: 'container-cart---checkoutView--invoiceStep' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceStep-nextButton',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--deliveryTypeStep-nextButton',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--submitOrder',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page
		.locateUI5Control({
			controlType: 'sap.m.Button',
			properties: { text: 'Yes' },
			searchOpenDialogs: true,
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
});
