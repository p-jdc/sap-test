// KI-generiert, geprüft von: <Name>
// The sales chain over the S/4HANA APIs: sales order → outbound delivery → picking → goods issue.
// No browser: the requests go straight to API_SALES_ORDER_SRV and API_OUTBOUND_DELIVERY_SRV through
// the typed clients in odata/clients.
// Against a real system, picking and goods issue need stock of the template order's material in
// its plant. If the shipping point belongs to a decentralized EWM, the delivery is picked and
// posted there, not in S/4HANA: PickAllItems fails, and this test does not apply to such a plant.
import moment from 'moment';
import { test, expect } from '../../sap-plugin/odata';
import { createSalesOrder, newReference } from '../../helpers/sales-order';

test('delivers a sales order: delivery with reference, picking and goods issue', async ({
	sapApi,
	salesOrder,
	outboundDelivery,
	cleanup
}) => {
	const { salesOrderApi: orders } = salesOrder;
	const {
		outbDeliveryHeaderApi: deliveries,
		outbDeliveryItemApi: deliveryItems,
		operations
	} = outboundDelivery;

	/**
	 * The delivery's ETag for If-Match: S/4HANA refuses the picking and goods issue actions without it
	 * (428). Read right before the action, as each action changes it. The mock hands out none and only
	 * checks that one is sent, so it gets `*`.
	 */
	const etagOf = async (delivery: string) =>
		(await deliveries.requestBuilder().getByKey(delivery).execute(sapApi)).versionIdentifier ?? '*';

	const order = await test.step('create the sales order', () =>
		createSalesOrder(salesOrder, sapApi, cleanup, newReference()));

	const delivery = await test.step('create the delivery with reference to the order', async () => {
		const draft = deliveries
			.entityBuilder()
			.toDeliveryDocumentItem([
				deliveryItems
					.entityBuilder()
					.referenceSdDocument(order.salesOrder)
					.referenceSdDocumentItem('10')
					.build()
			])
			.build();
		const created = await deliveries.requestBuilder().create(draft).execute(sapApi);
		// The system assigns the number.
		expect(created.deliveryDocument).toBeTruthy();
		// Runs before the order is deleted: cleanup steps run newest first.
		cleanup(`delete delivery ${created.deliveryDocument}`, () =>
			deliveries
				.requestBuilder()
				.delete(created.deliveryDocument)
				// The delivery has an ETag; If-Match: * deletes it whatever the test changed.
				.ignoreVersionIdentifier()
				.execute(sapApi)
		);

		const stored = await deliveries
			.requestBuilder()
			.getByKey(created.deliveryDocument)
			.select(
				deliveries.schema.DELIVERY_DOCUMENT,
				deliveries.schema.OVERALL_PICKING_STATUS,
				deliveries.schema.OVERALL_GOODS_MOVEMENT_STATUS,
				deliveries.schema.TO_DELIVERY_DOCUMENT_ITEM
			)
			.execute(sapApi);
		expect(stored.toDeliveryDocumentItem).toHaveLength(1);
		const [item] = stored.toDeliveryDocumentItem;
		expect(item.referenceSdDocument).toBe(order.salesOrder);
		expect(item.material).toBe(order.material);
		expect(item.actualDeliveryQuantity?.toNumber()).toBe(order.quantity);
		expect(stored.overallPickingStatus).toBe('A');
		expect(stored.overallGoodsMovementStatus).toBe('A');

		const delivered = await orders.requestBuilder().getByKey(order.salesOrder).execute(sapApi);
		expect(delivered.overallDeliveryStatus).toBe('C');
		return created.deliveryDocument;
	});

	await test.step('pick all items', async () => {
		await operations
			.pickAllItems({ deliveryDocument: delivery })
			.addCustomHeaders({ 'if-match': await etagOf(delivery) })
			.execute(sapApi);

		const picked = await deliveries.requestBuilder().getByKey(delivery).execute(sapApi);
		expect(picked.overallPickingStatus).toBe('C');
	});

	await test.step('post goods issue', async () => {
		await operations
			.postGoodsIssue({ deliveryDocument: delivery })
			.addCustomHeaders({ 'if-match': await etagOf(delivery) })
			.execute(sapApi);
		// Before the delivery is deleted: a delivery with goods issue cannot be deleted.
		cleanup(`reverse goods issue of delivery ${delivery}`, async () =>
			operations
				.reverseGoodsIssue({
					deliveryDocument: delivery,
					actualGoodsMovementDate: moment.utc().startOf('day')
				})
				.addCustomHeaders({ 'if-match': await etagOf(delivery) })
				.execute(sapApi)
		);

		const posted = await deliveries.requestBuilder().getByKey(delivery).execute(sapApi);
		expect(posted.overallGoodsMovementStatus).toBe('C');
		expect(posted.actualGoodsMovementDate?.isValid()).toBe(true);
	});
});
