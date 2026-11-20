import type { LocatorKind, Surface } from './types';

export function duration(ms: number | undefined): string {
	if (ms === undefined) return '–';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function when(iso: string | undefined): string {
	return iso ? new Date(iso).toLocaleString() : '–';
}

/** Keyed by TestStatus | RunStatus | StepStatus values. */
const DESIGNS = new Map<string, string>([
	['passed', 'Positive'],
	['failed', 'Negative'],
	['timedOut', 'Negative'],
	['error', 'Negative'],
	['interrupted', 'Critical'],
	['running', 'Information']
]);

/** UI5 Tag design for a status; anything else (pending, skipped, not run) is Neutral. */
export function statusDesign(status: string | undefined): string {
	return DESIGNS.get(status ?? '') ?? 'Neutral';
}

export const SURFACE_LABEL: Record<Surface, string> = {
	fiori: 'Fiori / UI5',
	webgui: 'SAP WebGUI',
	ariba: 'SAP Ariba',
	demo: 'Demo',
	other: 'Other'
};

export const LOCATOR_LABEL: Record<LocatorKind, string> = {
	ui5: 'UI5',
	sid: 'SID',
	'sid-path': 'SID path',
	role: 'Role',
	label: 'Label',
	text: 'Text',
	testid: 'Test ID',
	placeholder: 'Placeholder',
	css: 'CSS',
	xpath: 'XPath',
	other: 'Other'
};

/** SAP locators good, standard OK, CSS/XPath bad – mirrors the guide's locator order. */
export function locatorColor(kind: LocatorKind | undefined): string {
	if (kind === 'ui5' || kind === 'sid' || kind === 'sid-path') return '6';
	if (kind === 'css' || kind === 'xpath') return '2';
	return '9';
}
