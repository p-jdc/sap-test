// What the OData mock (SAP's fe-mockserver-core) does for A_SalesOrder beyond the rows in
// A_SalesOrder.json, so that tests can create and delete orders as on S/4HANA:
// - A new order without a number gets the next one, as the system's number range would give it.
// - A deep insert (header with to_Item, to_Partner, …) stores the parts in their own entity sets.
//   SAP's metadata names no referential constraints, so the mock would otherwise keep them inside
//   the order, without the order number, where A_SalesOrderItem and the other sets never see them.
//   The create answer therefore holds the header only; read the parts with $expand.
// - Deleting an order deletes its parts. An order with a delivery cannot be deleted, and a delete
//   without If-Match is refused (428), as S/4HANA refuses it.
// The mock loads this file with `require` when it starts or is reset.

/** Stands in for the number until it is given, just before the entry is stored. */
const NEW = '$new';

/**
 * S/4HANA keeps an ETag on this entity (ConcurrencyMode="Fixed" in the metadata) and answers 428 to
 * a change without If-Match. The mock hands out no ETag, so it only checks that one is sent: a test
 * that forgets it fails here and not first against a real system.
 */
function requireIfMatch(contributor, odataRequest, what) {
	if (!odataRequest?.headers?.['if-match'])
		contributor.throwError(
			`${what} needs the ETag in If-Match (Precondition Required). Read the entity first, or send If-Match: * to override.`,
			428
		);
}

/** The next number: one above the highest so far, as a number range would give it. */
async function nextNumber(base, odataRequest) {
	const rows = await base.getAllEntries(odataRequest, true);
	const highest = Math.max(0, ...rows.map((row) => Number(row.SalesOrder)).filter(Number.isFinite));
	return String(highest + 1);
}

/** Key fields of each entity set this file touches, besides SalesOrder. */
const KEYS = {
	A_SalesOrderItem: ['SalesOrderItem'],
	A_SalesOrderHeaderPartner: ['PartnerFunction'],
	A_SalesOrderHeaderPrElement: ['PricingProcedureStep', 'PricingProcedureCounter'],
	A_SalesOrderText: ['Language', 'LongTextID'],
	A_SalesOrderScheduleLine: ['SalesOrderItem', 'ScheduleLine'],
	A_SalesOrderItemPartner: ['SalesOrderItem', 'PartnerFunction'],
	A_SalesOrderItemPrElement: ['SalesOrderItem', 'PricingProcedureStep', 'PricingProcedureCounter'],
	A_SalesOrderItemText: ['SalesOrderItem', 'Language', 'LongTextID']
};

/** Navigation property → entity set, with the parts of an item one level further down. */
const HEADER_PARTS = [
	['to_Partner', 'A_SalesOrderHeaderPartner'],
	['to_PricingElement', 'A_SalesOrderHeaderPrElement'],
	['to_Text', 'A_SalesOrderText'],
	['to_Item', 'A_SalesOrderItem']
];
const ITEM_PARTS = [
	['to_ScheduleLine', 'A_SalesOrderScheduleLine'],
	['to_Partner', 'A_SalesOrderItemPartner'],
	['to_PricingElement', 'A_SalesOrderItemPrElement'],
	['to_Text', 'A_SalesOrderItemText']
];

/** The rows of a deep-insert part: `{ results: [...] }` as OData V2 sends it, or a plain array. */
function rowsOf(value) {
	if (Array.isArray(value)) return value;
	if (value && Array.isArray(value.results)) return value.results;
	return [];
}

/** Moves the deep-insert parts out of `parent` into their entity sets, with the parent's keys. */
async function storeParts(base, parent, keys, parts, odataRequest) {
	for (const [navigation, entitySet] of parts) {
		const rows = rowsOf(parent[navigation]);
		delete parent[navigation];
		if (rows.length === 0) continue;
		const target = await base.getEntityInterface(entitySet);
		for (const [index, row] of rows.entries()) {
			const entry = { ...row, ...keys };
			if (entitySet === 'A_SalesOrderScheduleLine' && !entry.ScheduleLine)
				entry.ScheduleLine = String(index + 1);
			if (entitySet === 'A_SalesOrderItem') {
				await storeParts(
					base,
					entry,
					{ ...keys, SalesOrderItem: entry.SalesOrderItem },
					ITEM_PARTS,
					odataRequest
				);
			}
			await target.addEntry(entry, odataRequest);
		}
	}
}

export default {
	// The core asks for a key before the checks, also for refused entries; the number is given
	// only when the entry is stored.
	generateKey(property) {
		return property.name === 'SalesOrder' ? NEW : undefined;
	},

	async onBeforeAddEntry(_keys, data, odataRequest) {
		if (data.SalesOrder === NEW) data.SalesOrder = await nextNumber(this.base, odataRequest);
	},

	async onAfterAddEntry(_keys, data, odataRequest) {
		await storeParts(this.base, data, { SalesOrder: data.SalesOrder }, HEADER_PARTS, odataRequest);
	},

	async removeEntry(keyValues, odataRequest) {
		requireIfMatch(this, odataRequest, `Deleting sales order ${keyValues.SalesOrder}`);
		const items = await this.base.getEntityInterface('A_SalesOrderItem');
		const delivered = (await items.getAllEntries(odataRequest, true)).some(
			(row) =>
				row.SalesOrder === keyValues.SalesOrder &&
				(row.DeliveryStatus === 'B' || row.DeliveryStatus === 'C')
		);
		// As on S/4HANA: an order with a delivery cannot be deleted.
		if (delivered)
			this.throwError(`Sales order ${keyValues.SalesOrder} has subsequent documents.`, 400);
		await this.base.removeEntry(keyValues, odataRequest);
		for (const [entitySet, keyNames] of Object.entries(KEYS)) {
			const target = await this.base.getEntityInterface(entitySet);
			const rows = (await target.getAllEntries(odataRequest)).filter(
				(row) => row.SalesOrder === keyValues.SalesOrder
			);
			for (const row of rows) {
				const keys = { SalesOrder: row.SalesOrder };
				for (const name of keyNames) keys[name] = row[name];
				await target.removeEntry(keys, odataRequest);
			}
		}
	}
};
