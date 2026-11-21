// SPIKE. Recorded by hand with the UI5 recorder of this branch (node sap-plugin/record.mjs) and left
// as recorded: no positions, no XPath. It adds whichever product the demo promotes first and
// checks out with cash on delivery. No assertions yet; the recorder does not write any.
import { test } from '../../sap-plugin';

test('recorded', async ({ page }) => {
	await page.goto(
		'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark'
	);
	await page
		.locateUI5Control({
			controlType: 'sap.m.Button',
			viewName: 'sap.ui.demo.cart.view.Welcome',
			viewId: 'container-cart---welcomeView',
			i18NText: { propertyName: 'tooltip', key: 'addToCart' },
			sibling: [
				{
					controlType: 'sap.m.Image',
					viewName: 'sap.ui.demo.cart.view.Welcome',
					viewId: 'container-cart---welcomeView',
					bindingPath: {
						path: '/Promoted/0',
						propertyPath: 'Product/PictureUrl',
						modelName: 'view'
					}
				},
				{ level: 0 }
			]
		})
		.click();
	await page
		.locateUI5Control({
			controlType: 'sap.ui.core.Icon',
			viewName: 'sap.ui.demo.cart.view.Welcome',
			viewId: 'container-cart---welcomeView',
			properties: { src: { regex: { source: 'cart' } } },
			ancestor: {
				controlType: 'sap.m.ToggleButton',
				viewName: 'sap.ui.demo.cart.view.Welcome',
				viewId: 'container-cart---welcomeView',
				bindingPath: { path: '', propertyPath: '/layout', modelName: 'appView' }
			}
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
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--paymentTypeStep-nextButton',
			interaction: { idSuffix: 'BDI-content' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryName',
			interaction: { idSuffix: 'inner' }
		})
		.fill('dgfdgf');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryLastName',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryLastName',
			interaction: { idSuffix: 'inner' }
		})
		.fill('dfgdfg');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryPhoneNumber',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryPhoneNumber',
			interaction: { idSuffix: 'inner' }
		})
		.fill('34243234');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryEmail',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryEmail',
			interaction: { idSuffix: 'inner' }
		})
		.fill('tewt@test.com');
	await page.locateUI5Control({ id: 'container-cart---checkoutView--cashOnDeliveryStep' }).click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--cashOnDeliveryStep-nextButton',
			interaction: { idSuffix: 'content' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressAddress',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressAddress',
			interaction: { idSuffix: 'inner' }
		})
		.fill('sfsdfsd');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressCity',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressCity',
			interaction: { idSuffix: 'inner' }
		})
		.fill('sdfds');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressZip',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressZip',
			interaction: { idSuffix: 'inner' }
		})
		.fill('23424');
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressCountry',
			interaction: { idSuffix: 'inner' }
		})
		.click();
	await page
		.locateUI5Control({
			id: 'container-cart---checkoutView--invoiceAddressCountry',
			interaction: { idSuffix: 'inner' }
		})
		.fill('sdfdfdsf');
	await page.locateUI5Control({ id: 'container-cart---checkoutView--invoiceStep' }).click();
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
