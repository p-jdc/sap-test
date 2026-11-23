// What the OData mock (SAP's fe-mockserver-core) does for A_OutbDeliveryItem beyond the rows in
// A_OutbDeliveryItem.json: the actions bound to a delivery item (CreateBatchSplitItem) are not
// simulated and answer 501, instead of the core's default of answering with the request's own data.
// The actions the mock simulates are in A_OutbDeliveryHeader.js.
export default {
	executeAction(action) {
		return this.throwError(`The mock does not simulate ${action.name}.`, 501);
	}
};
