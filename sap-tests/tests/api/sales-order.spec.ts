// KI-generiert, geprüft von: <Name>
// OData tests against the S/4HANA sales order API API_SALES_ORDER_SRV, the first step of the chain
// order → delivery → goods issue → billing. No browser: the requests go straight to the service
// through the typed client in odata/clients.
import { test, expect } from '../../sap-plugin/odata';
import { createSalesOrder, newReference } from '../../helpers/sales-order';

test('reads a sales order with its items, schedule lines and partners', async ({
	sapApi,
	salesOrder
}) => {
	const {
		salesOrderApi: orders,
		salesOrderItemApi: items,
		salesOrderHeaderPartnerApi: partners
	} = salesOrder;

	const [order] = await orders
		.requestBuilder()
		.getAll()
		// OData V2: selecting a navigation property expands it.
		.select(
			orders.schema.SALES_ORDER,
			orders.schema.SOLD_TO_PARTY,
			orders.schema.TO_ITEM.select(
				items.schema.SALES_ORDER,
				items.schema.SALES_ORDER_ITEM,
				items.schema.TO_SCHEDULE_LINE
			),
			orders.schema.TO_PARTNER.select(
				partners.schema.SALES_ORDER,
				partners.schema.PARTNER_FUNCTION,
				partners.schema.CUSTOMER
			)
		)
		.top(1)
		.execute(sapApi);

	expect(order, 'the service returned no sales order').toBeDefined();
	expect(order.toItem.length).toBeGreaterThan(0);
	for (const item of order.toItem) {
		expect(item.salesOrder).toBe(order.salesOrder);
		for (const line of item.toScheduleLine) expect(line.salesOrderItem).toBe(item.salesOrderItem);
	}
	// The sold-to party (partner function AG) is the order's SoldToParty.
	const soldTo = order.toPartner.find((partner) => partner.partnerFunction === 'AG');
	expect(soldTo?.customer).toBe(order.soldToParty);
});

test('creates a sales order with an item and changes it', async ({
	sapApi,
	salesOrder,
	cleanup
}) => {
	const { salesOrderApi: orders } = salesOrder;
	const reference = newReference();

	const created = await test.step('create header and item in one request', async () => {
		const order = await createSalesOrder(salesOrder, sapApi, cleanup, reference);

		const stored = await orders
			.requestBuilder()
			.getByKey(order.salesOrder)
			.select(
				orders.schema.SALES_ORDER,
				orders.schema.PURCHASE_ORDER_BY_CUSTOMER,
				orders.schema.SOLD_TO_PARTY,
				orders.schema.TO_ITEM
			)
			.execute(sapApi);
		expect(stored.purchaseOrderByCustomer).toBe(reference);
		expect(stored.soldToParty).toBe(order.soldToParty);
		expect(stored.toItem).toHaveLength(1);
		expect(stored.toItem[0].material).toBe(order.material);
		expect(stored.toItem[0].requestedQuantity?.toNumber()).toBe(order.quantity);
		return order;
	});

	await test.step('change the customer reference', async () => {
		const order = await orders.requestBuilder().getByKey(created.salesOrder).execute(sapApi);
		order.purchaseOrderByCustomer = `${reference}-2`;
		// Sends only the changed field; the CSRF token is handled by the SDK.
		await orders.requestBuilder().update(order).execute(sapApi);

		const changed = await orders.requestBuilder().getByKey(created.salesOrder).execute(sapApi);
		expect(changed.purchaseOrderByCustomer).toBe(`${reference}-2`);
	});
});
