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

const STATUS_LABELS = new Map<string, string>([
	['passed', 'Passed'],
	['failed', 'Failed'],
	['timedOut', 'Took too long'],
	['error', 'Could not run'],
	['interrupted', 'Stopped'],
	['running', 'Running'],
	['skipped', 'Skipped'],
	['pending', 'Waiting']
]);

/** A status in words for people; a missing status means the test has never been run. */
export function statusLabel(status: string | undefined): string {
	return status ? (STATUS_LABELS.get(status) ?? status) : 'Not run yet';
}

/** `fiori/create-order.spec.ts` → `Create order`: a spec file's name without path and code suffixes. */
export function specName(file: string): string {
	const base = (file.split('/').at(-1) ?? file).replace(/\.(spec|test)\.[cm]?[jt]s$/, '');
	const text = base.replaceAll(/[._-]+/g, ' ').trim();
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a run covered, in words. Its files are spec paths, optionally `:line` for one test, or folders. */
export function scopeLabel(files: string[]): string {
	if (files.length === 0) return 'All tests';
	return files
		.map((f) => {
			const [, path = f, line] = /^(.*?)(?::(\d+))?$/.exec(f) ?? [];
			if (!/\.[cm]?[jt]s$/.test(path)) return `${specName(path)} tests`;
			return line ? `One test in ${specName(path)}` : specName(path);
		})
		.join(', ');
}

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
