// KI-generiert, geprüft von: <Name>
// OData tests against the SAP Gateway sample service GWSAMPLE_BASIC, which ships with every ABAP
// system (activate it in /IWFND/MAINT_SERVICE). No browser: the requests go straight to the
// service through the typed client in odata/clients.
import { BigNumber } from 'bignumber.js';
import { test, expect } from '../../sap-plugin/odata';

const CATEGORY = 'Notebooks';

/** A product ID nobody else uses (ProductID allows 10 characters). */
const newProductId = () => `PW${Date.now().toString(36).toUpperCase()}`.slice(0, 10);

test('reads products of one category with a typed filter', async ({ sapApi, gwsample }) => {
	const { productSetApi: products } = gwsample;

	const notebooks = await products
		.requestBuilder()
		.getAll()
		.filter(products.schema.CATEGORY.equals(CATEGORY))
		.select(products.schema.PRODUCT_ID, products.schema.NAME, products.schema.CATEGORY)
		.top(5)
		.execute(sapApi);

	expect(notebooks.length).toBeGreaterThan(0);
	for (const product of notebooks) expect(product.category).toBe(CATEGORY);
});

test('reads a sales order with its line items', async ({ sapApi, gwsample }) => {
	const { salesOrderSetApi: orders } = gwsample;

	const [order] = await orders
		.requestBuilder()
		.getAll()
		// OData V2: selecting a navigation property expands it.
		.select(orders.schema.SALES_ORDER_ID, orders.schema.TO_LINE_ITEMS)
		.top(1)
		.execute(sapApi);

	expect(order, 'the service returned no sales order').toBeDefined();
	expect(order.toLineItems.length).toBeGreaterThan(0);
	for (const item of order.toLineItems) expect(item.salesOrderId).toBe(order.salesOrderId);
});

test('reads products and sales orders in one $batch request', async ({ sapApi, gwsample }) => {
	const { productSetApi: products, salesOrderSetApi: orders } = gwsample;

	const [productPart, orderPart] = await gwsample
		.batch(products.requestBuilder().getAll().top(3), orders.requestBuilder().getAll().top(3))
		// Parts as `ProductSet?…`, relative to the service, like UI5 apps send them. The SDK's
		// default (the full /sap/opu/odata/… path) is not understood by the local mock.
		.withSubRequestPathType('noPath')
		.execute(sapApi);

	if (!productPart.isReadResponse() || !orderPart.isReadResponse())
		throw new Error('a part of the $batch request failed');
	expect(productPart.as(products).length).toBeGreaterThan(0);
	expect(orderPart.as(orders).length).toBeGreaterThan(0);
});

test('creates and changes a product', async ({ sapApi, gwsample, cleanup }) => {
	const { productSetApi: products } = gwsample;
	const productId = newProductId();

	// Codes (type, supplier, tax, unit, currency) come from an existing product, so the test does
	// not depend on how the system's customizing names them.
	const [template] = await products.requestBuilder().getAll().top(1).execute(sapApi);
	expect(template, 'the service returned no product to copy codes from').toBeDefined();

	await test.step('create', async () => {
		const draft = products
			.entityBuilder()
			.productId(productId)
			.typeCode(template.typeCode)
			.category(template.category)
			.name('Playwright test product')
			.supplierId(template.supplierId)
			.taxTarifCode(template.taxTarifCode)
			.measureUnit(template.measureUnit)
			.currencyCode(template.currencyCode)
			.price(new BigNumber('9.99'))
			.build();
		await products.requestBuilder().create(draft).execute(sapApi);
		cleanup(`delete product ${productId}`, () =>
			products.requestBuilder().delete(productId).execute(sapApi)
		);

		const created = await products.requestBuilder().getByKey(productId).execute(sapApi);
		expect(created.name).toBe('Playwright test product');
		expect(created.price?.toNumber()).toBe(9.99);
	});

	await test.step('change the price', async () => {
		const product = await products.requestBuilder().getByKey(productId).execute(sapApi);
		product.price = new BigNumber('19.99');
		// Sends only the changed field; the CSRF token and an ETag, if the service uses one, are
		// handled by the SDK.
		await products.requestBuilder().update(product).execute(sapApi);

		const changed = await products.requestBuilder().getByKey(productId).execute(sapApi);
		expect(changed.price?.toNumber()).toBe(19.99);
	});
});
