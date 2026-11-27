/** A failed Octane request, with a message that can be shown on the page. */
export class OctaneError extends Error {
	constructor(
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'OctaneError';
	}
}
