// Shared steps for the API tests of the S/4HANA sales chain (tests/api/sales-order*.spec.ts).
import type { HttpDestination } from '@sap-cloud-sdk/connectivity';
import { desc } from '@sap-cloud-sdk/odata-v2';
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

/**
 * The order type the tests copy and create: the standard order's key (OR, shown as TA in German).
 * Types that deliver on saving (rush order, cash sale) would break the delivery test.
 */
const ORDER_TYPE = 'OR';

/** HigherLevelItem of a main item: S/4HANA sends the empty number as "0" (or "000000"). */
const isMainItem = (higherLevelItem: string | null | undefined) =>
	/^0*$/.test(higherLevelItem ?? '');

/** A customer reference nobody else uses, to find the test's own documents. */
export const newReference = () => `PW-${Date.now().toString(36).toUpperCase()}`;

/**
 * Creates a sales order with one item (header and item in one request) and registers its deletion.
 * Organization, customer and material come from the newest standard order without delivery or
 * billing block that is not rejected, and its first main item with a material, so the test does not
 * depend on how the system's customizing and master data are named.
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
			orders.schema.TO_ITEM.select(
				items.schema.MATERIAL,
				items.schema.REQUESTED_QUANTITY_UNIT,
				items.schema.HIGHER_LEVEL_ITEM
			)
		)
		.filter(
			orders.schema.SALES_ORDER_TYPE.equals(ORDER_TYPE),
			orders.schema.DELIVERY_BLOCK_REASON.equals(''),
			orders.schema.HEADER_BILLING_BLOCK_REASON.equals(''),
			orders.schema.OVERALL_SD_DOCUMENT_REJECTION_STS.notEquals('C')
		)
		// The newest: old, migrated orders are the likeliest to use blocked material or types.
		.orderBy(desc(orders.schema.SALES_ORDER))
		.top(1)
		.execute(sapApi);
	expect(
		template,
		'the service returned no unblocked sales order to copy codes from'
	).toBeDefined();
	const templateItem = template.toItem.find(
		(item) => isMainItem(item.higherLevelItem) && item.material
	);
	expect(templateItem, 'the template order has no main item with a material').toBeDefined();
	const soldToParty = template.soldToParty ?? '';
	const material = templateItem?.material ?? '';
	const unit = templateItem?.requestedQuantityUnit ?? '';

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
		orders
			.requestBuilder()
			.delete(created.salesOrder)
			// The order has an ETag; If-Match: * deletes it whatever the test changed.
			.ignoreVersionIdentifier()
			.execute(sapApi)
	);
	return { salesOrder: created.salesOrder, soldToParty, material, unit, quantity };
}
