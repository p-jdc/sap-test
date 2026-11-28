import {
	SELF_SIGNED_SETTING,
	selfSignedHostProblem
} from '../../../sap-tests/sap-plugin/self-signed.js';
import { allowsCredentials } from './origin.js';
import type { SettingName } from '#lib/shared/types.js';

/** Why `value` cannot be saved as this setting, or undefined when it can. */
export function settingProblem(setting: SettingName, value: string): string | undefined {
	if (setting.endsWith('_URL') && !URL.canParse(value)) {
		return `${setting} must be a full URL, for example https://sap.example.com.`;
	}
	// Every address setting is a system the tests sign in to with a user and password.
	if (setting.endsWith('_URL') && !allowsCredentials(value)) {
		return `${setting} must start with https://. Over http:// the password would cross the network unencrypted; only an address on this computer (localhost) may use http://.`;
	}
	if (setting === 'SAP_API_URL' || /^IDOC_(S4|EWM)_URL$/.test(setting)) {
		// The OData clients and the IDoc sender append the service path themselves.
		const url = new URL(value);
		if (url.pathname !== '/' || url.search || url.hash) {
			return `${setting} must be the host only, without a path: ${url.origin}`;
		}
	}
	if (
		(setting === 'SAP_CLIENT' || /^IDOC_(S4|EWM)_CLIENT$/.test(setting)) &&
		!/^\d{3}$/.test(value)
	) {
		return `${setting} must be the three digits of an SAP client, for example 100.`;
	}
	if (setting === 'OCTANE_URL') {
		// The importer appends /authentication and /api itself. A link copied from the browser has /ui.
		const url = new URL(value);
		if (/^\/(ui|api|authentication)(\/|$)/.test(url.pathname) || url.search || url.hash) {
			return `OCTANE_URL must be the Octane server without /ui or /api, for example ${url.origin}. The shared space and workspace are the two numbers after ?p= in a link to Octane.`;
		}
	}
	if (
		(setting === 'OCTANE_SHARED_SPACE' || setting === 'OCTANE_WORKSPACE') &&
		!/^\d+$/.test(value)
	) {
		return `${setting} must be a number: in a link to Octane, ?p=<shared space>/<workspace>.`;
	}
	if (setting === SELF_SIGNED_SETTING) return selfSignedHostProblem(value);
	return undefined;
}
