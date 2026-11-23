// What the OData mock (SAP's fe-mockserver-core) does for outbound deliveries beyond the rows in
// A_OutbDeliveryHeader.json, so that a test can run order → delivery → picking → goods issue:
// - A new delivery without a number gets the next one. It must have items that refer to sales order items
//   (ReferenceSDDocument, ReferenceSDDocumentItem) of the sales order mock; material, plant, unit
//   and, unless given, the quantity come from there, and the order items count as delivered.
//   The items of the deep insert are stored in A_OutbDeliveryItem (SAP's metadata names no
//   referential constraints, so the mock would keep them inside the delivery). The create answer
//   therefore holds the header only; read the items with $expand.
// - The actions PickAllItems, PostGoodsIssue and ReverseGoodsIssue set the statuses as S/4HANA
//   does. Goods issue needs complete picking. Any other action of the service answers 501.
// - Deleting a delivery deletes its items and partners and opens the order items again.
// What the mock does not do: stock, warehouse tasks, availability checks, partial deliveries.
// The mock loads this file with `require` when it starts or is reset.

/** Stands in for the number until it is given, just before the entry is stored. */
const NEW = '$new';

/** The next number: one above the highest so far, as a number range would give it. */
async function nextNumber(base, odataRequest) {
	const rows = await base.getAllEntries(odataRequest, true);
	const highest = Math.max(
		0,
		...rows.map((row) => Number(row.DeliveryDocument)).filter(Number.isFinite)
	);
	return String(highest + 1);
}

const SALES_ORDERS = 'API_SALES_ORDER_SRV';

/**
 * A function import parameter. OData V2 sends them in the URL as literals ('80000001'); the mock
 * core hands the action only the body, so they are read from the request's URL parameters.
 */
function parameter(odataRequest, data, name) {
	const value = data?.[name] ?? odataRequest.allParams?.get(name);
	return typeof value === 'string' ? value.replace(/^'(.*)'$/, '$1') : value;
}

/** Today at midnight UTC, as Edm.DateTime in OData V2 JSON. */
function today() {
	const now = new Date();
	return `/Date(${Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())})/`;
}

/** The rows of a deep-insert part: `{ results: [...] }` as OData V2 sends it, or a plain array. */
function rowsOf(value) {
	if (Array.isArray(value)) return value;
	if (value && Array.isArray(value.results)) return value.results;
	return [];
}

async function salesOrderItem(base, order, item) {
	const items = await base.getEntityInterface('A_SalesOrderItem', SALES_ORDERS);
	const [row] = items ? await items.fetchEntries({ SalesOrder: order, SalesOrderItem: item }) : [];
	return row;
}

/** Sets the delivery status of the order header from its items: C when all are delivered. */
async function updateOrderStatus(base, order) {
	const items = await base.getEntityInterface('A_SalesOrderItem', SALES_ORDERS);
	const headers = await base.getEntityInterface('A_SalesOrder', SALES_ORDERS);
	if (!items || !headers) return;
	const [header] = await headers.fetchEntries({ SalesOrder: order });
	if (!header) return;
	const rows = (await items.getAllEntries(undefined, true)).filter(
		(row) => row.SalesOrder === order
	);
	const delivered = rows.filter((row) => row.DeliveryStatus === 'C').length;
	header.OverallDeliveryStatus = delivered === 0 ? 'A' : delivered === rows.length ? 'C' : 'B';
}

async function deliveryItems(base, delivery, odataRequest) {
	const items = await base.getEntityInterface('A_OutbDeliveryItem');
	return (await items.getAllEntries(odataRequest, true)).filter(
		(row) => row.DeliveryDocument === delivery
	);
}

/** The answer of the picking and goods issue actions: one success line per item. */
const report = (items) =>
	items.map((item) => ({
		DeliveryDocument: item.DeliveryDocument,
		DeliveryDocumentItem: item.DeliveryDocumentItem,
		Material: item.Material,
		ActualDeliveryQuantity: item.ActualDeliveryQuantity,
		DeliveryQuantityUnit: item.DeliveryQuantityUnit,
		SystemMessageType: 'S'
	}));

export default {
	// The core asks for a key before the checks, also for refused entries; the number is given
	// only when the entry is stored.
	generateKey(property) {
		return property.name === 'DeliveryDocument' ? NEW : undefined;
	},

	// Checked before the delivery is stored, so a refused one leaves nothing behind.
	async onBeforeAddEntry(_keys, header, odataRequest) {
		const rows = rowsOf(header.to_DeliveryDocumentItem);
		if (rows.length === 0)
			this.throwError('A delivery needs items that refer to sales order items.', 400);
		for (const row of rows) {
			const orderItem = await salesOrderItem(
				this.base,
				row.ReferenceSDDocument,
				row.ReferenceSDDocumentItem
			);
			if (!orderItem)
				this.throwError(
					`Sales order item ${row.ReferenceSDDocument}/${row.ReferenceSDDocumentItem} does not exist.`,
					400
				);
			if (orderItem.DeliveryStatus === 'C')
				this.throwError(
					`Sales order item ${row.ReferenceSDDocument}/${row.ReferenceSDDocumentItem} is already delivered.`,
					400
				);
		}
		if (header.DeliveryDocument === NEW)
			header.DeliveryDocument = await nextNumber(this.base, odataRequest);
	},

	async onAfterAddEntry(_keys, header, odataRequest) {
		const delivery = header.DeliveryDocument;
		const rows = rowsOf(header.to_DeliveryDocumentItem);
		const partners = rowsOf(header.to_DeliveryDocumentPartner);
		delete header.to_DeliveryDocumentItem;
		delete header.to_DeliveryDocumentPartner;
		for (const status of [
			'OverallSDProcessStatus',
			'OverallPickingStatus',
			'OverallGoodsMovementStatus',
			'OverallDelivReltdBillgStatus'
		])
			header[status] ||= 'A';
		// The core fills every date with today; goods issue is not posted yet.
		header.ActualGoodsMovementDate = null;
		header.DeliveryDocumentType ||= 'LF';
		header.DocumentDate ||= today();

		const items = await this.base.getEntityInterface('A_OutbDeliveryItem');
		const orders = new Set();
		for (const [index, row] of rows.entries()) {
			const orderItem = await salesOrderItem(
				this.base,
				row.ReferenceSDDocument,
				row.ReferenceSDDocumentItem
			);
			const quantity = row.ActualDeliveryQuantity || orderItem.RequestedQuantity;
			await items.addEntry(
				{
					...row,
					DeliveryDocument: delivery,
					DeliveryDocumentItem: row.DeliveryDocumentItem || String((index + 1) * 10),
					ReferenceSDDocumentCategory: 'C',
					Material: orderItem.Material,
					DeliveryDocumentItemText: orderItem.SalesOrderItemText,
					Plant: orderItem.ProductionPlant,
					DeliveryQuantityUnit: orderItem.OrderQuantityUnit || orderItem.RequestedQuantityUnit,
					ActualDeliveryQuantity: quantity,
					OriginalDeliveryQuantity: quantity,
					SDProcessStatus: 'A',
					PickingStatus: 'A',
					GoodsMovementStatus: 'A',
					DeliveryRelatedBillingStatus: 'A'
				},
				odataRequest
			);
			orderItem.DeliveryStatus = 'C';
			orders.add(row.ReferenceSDDocument);
		}
		for (const order of orders) await updateOrderStatus(this.base, order);

		const firstOrder = rows[0].ReferenceSDDocument;
		const [order] = await (
			await this.base.getEntityInterface('A_SalesOrder', SALES_ORDERS)
		).fetchEntries({ SalesOrder: firstOrder });
		header.SoldToParty ||= order?.SoldToParty;
		header.ShipToParty ||= order?.SoldToParty;
		const partnerSet = await this.base.getEntityInterface('A_OutbDeliveryPartner');
		for (const partner of partners)
			await partnerSet.addEntry(
				{ SDDocumentItem: '0', ...partner, SDDocument: delivery },
				odataRequest
			);
	},

	async executeAction(action, data, _keys, odataRequest) {
		const delivery = parameter(odataRequest, data, 'DeliveryDocument');
		const [header] = await this.base.fetchEntries({ DeliveryDocument: delivery }, odataRequest);
		if (!header) this.throwError(`Delivery ${delivery} does not exist.`, 404);
		const items = await deliveryItems(this.base, delivery, odataRequest);
		switch (action.name) {
			case 'PickAllItems':
				if (header.OverallGoodsMovementStatus === 'C')
					this.throwError(`Goods issue for delivery ${delivery} is already posted.`, 400);
				for (const item of items) item.PickingStatus = 'C';
				header.OverallPickingStatus = 'C';
				return report(items);
			case 'PostGoodsIssue':
				if (header.OverallPickingStatus !== 'C')
					this.throwError(`Delivery ${delivery} is not picked completely.`, 400);
				if (header.OverallGoodsMovementStatus === 'C')
					this.throwError(`Goods issue for delivery ${delivery} is already posted.`, 400);
				for (const item of items) item.GoodsMovementStatus = 'C';
				header.OverallGoodsMovementStatus = 'C';
				header.OverallSDProcessStatus = 'C';
				header.ActualGoodsMovementDate = today();
				return report(items);
			case 'ReverseGoodsIssue':
				if (header.OverallGoodsMovementStatus !== 'C')
					this.throwError(`Goods issue for delivery ${delivery} is not posted.`, 400);
				for (const item of items) item.GoodsMovementStatus = 'A';
				header.OverallGoodsMovementStatus = 'A';
				header.OverallSDProcessStatus = 'B';
				header.ActualGoodsMovementDate = null;
				return [];
			default:
				return this.throwError(`The mock does not simulate ${action.name}.`, 501);
		}
	},

	async removeEntry(keyValues, odataRequest) {
		const delivery = keyValues.DeliveryDocument;
		const [header] = await this.base.fetchEntries({ DeliveryDocument: delivery }, odataRequest);
		if (header?.OverallGoodsMovementStatus === 'C')
			this.throwError(`Reverse the goods issue of delivery ${delivery} first.`, 400);
		const items = await deliveryItems(this.base, delivery, odataRequest);
		await this.base.removeEntry(keyValues, odataRequest);
		const itemSet = await this.base.getEntityInterface('A_OutbDeliveryItem');
		const orders = new Set();
		for (const item of items) {
			await itemSet.removeEntry(
				{ DeliveryDocument: delivery, DeliveryDocumentItem: item.DeliveryDocumentItem },
				odataRequest
			);
			const orderItem = await salesOrderItem(
				this.base,
				item.ReferenceSDDocument,
				item.ReferenceSDDocumentItem
			);
			if (orderItem) orderItem.DeliveryStatus = 'A';
			orders.add(item.ReferenceSDDocument);
		}
		for (const order of orders) await updateOrderStatus(this.base, order);
		const partnerSet = await this.base.getEntityInterface('A_OutbDeliveryPartner');
		for (const partner of (await partnerSet.getAllEntries(odataRequest, true)).filter(
			(row) => row.SDDocument === delivery
		))
			await partnerSet.removeEntry(
				{ SDDocument: delivery, PartnerFunction: partner.PartnerFunction },
				odataRequest
			);
	}
};
