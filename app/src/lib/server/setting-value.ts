import type { SettingName } from '#lib/shared/types.js';

/** Why `value` cannot be saved as this setting, or undefined when it can. */
export function settingProblem(setting: SettingName, value: string): string | undefined {
	if (setting.endsWith('_URL') && !URL.canParse(value)) {
		return `${setting} must be a full URL, for example https://sap.example.com.`;
	}
	if (setting === 'SAP_API_URL') {
		// The OData clients append the service path themselves.
		const url = new URL(value);
		if (url.pathname !== '/' || url.search || url.hash) {
			return `${setting} must be the host only, without a path: ${url.origin}`;
		}
	}
	if (setting === 'SAP_CLIENT' && !/^\d{3}$/.test(value)) {
		return `${setting} must be the three digits of an SAP client, for example 100.`;
	}
	return undefined;
}
