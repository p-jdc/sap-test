// Shared steps for the API tests of the S/4HANA sales chain (tests/api/sales-order*.spec.ts).
import type { HttpDestination } from '@sap-cloud-sdk/connectivity';
import { BigNumber } from 'bignumber.js';
import { expect } from '@playwright/test';
import type { Cleanup, SapApiFixtures } from '../sap-plugin/odata';

type SalesOrderClient = SapApiFixtures['salesOrder'];

export interface NewSalesOrder {
	salesOrder: string;
	soldToParty: string;
	material: string;
	unit: string;
	quantity: number;
}

/** A customer reference nobody else uses, to find the test's own documents. */
export const newReference = () => `PW-${Date.now().toString(36).toUpperCase()}`;

/**
 * Creates a sales order with one item (header and item in one request) and registers its deletion.
 * Organization, customer and material come from an existing order with an item, so the test does
 * not depend on how the system's customizing and master data are named.
 */
export async function createSalesOrder(
	client: SalesOrderClient,
	sapApi: HttpDestination,
	cleanup: Cleanup,
	reference: string,
	quantity = 2
): Promise<NewSalesOrder> {
	const { salesOrderApi: orders, salesOrderItemApi: items } = client;
	const [template] = await orders
		.requestBuilder()
		.getAll()
		.select(
			orders.schema.SALES_ORDER_TYPE,
			orders.schema.SALES_ORGANIZATION,
			orders.schema.DISTRIBUTION_CHANNEL,
			orders.schema.ORGANIZATION_DIVISION,
			orders.schema.SOLD_TO_PARTY,
			orders.schema.TO_ITEM.select(items.schema.MATERIAL, items.schema.REQUESTED_QUANTITY_UNIT)
		)
		.top(1)
		.execute(sapApi);
	expect(template, 'the service returned no sales order to copy codes from').toBeDefined();
	const [templateItem] = template.toItem;
	expect(templateItem, 'the template order has no item').toBeDefined();
	const soldToParty = template.soldToParty ?? '';
	const material = templateItem.material ?? '';
	const unit = templateItem.requestedQuantityUnit ?? '';

	const draft = orders
		.entityBuilder()
		.salesOrderType(template.salesOrderType)
		.salesOrganization(template.salesOrganization)
		.distributionChannel(template.distributionChannel)
		.organizationDivision(template.organizationDivision)
		.soldToParty(soldToParty)
		.purchaseOrderByCustomer(reference)
		.toItem([
			items
				.entityBuilder()
				.salesOrderItem('10')
				.material(material)
				.requestedQuantity(new BigNumber(quantity))
				.requestedQuantityUnit(unit)
				.build()
		])
		.build();
	const created = await orders.requestBuilder().create(draft).execute(sapApi);
	// The system assigns the number.
	expect(created.salesOrder).toBeTruthy();
	cleanup(`delete sales order ${created.salesOrder}`, () =>
		orders.requestBuilder().delete(created.salesOrder).execute(sapApi)
	);
	return { salesOrder: created.salesOrder, soldToParty, material, unit, quantity };
}
