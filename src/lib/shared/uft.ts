/**
 * Moving UFT One tests (Micro Focus / OpenText) into this test project: what the page and the server
 * share. The UFT tests come from a folder the person uploads or from a Git repository; the server
 * side is src/lib/server/uft-*.ts. Separate from the Octane importer: Octane holds manual tests,
 * UFT the automated ones, and the two are never mixed.
 */

/**
 * The Git repository the UFT tests are read from: its HTTPS address, the branch (empty: the
 * repository's default branch), and a user and access token with read rights. Only the app reads
 * them: test runs and recordings never get them.
 */
export const UFT_SETTINGS = [
	'UFT_GIT_URL',
	'UFT_GIT_BRANCH',
	'UFT_GIT_USER',
	'UFT_GIT_TOKEN'
] as const;

/**
 * The files the importer reads, by their ending: action scripts (Script.mts), function libraries,
 * object repositories exported as XML (UFT's Object Repository Manager: File › Export to XML) and
 * the test's settings file. Everything else of a UFT test (Test.tsp, *.mtr, the binary
 * ObjectRepository.bdb, Default.xls, snapshots) is binary and is neither uploaded nor checked out.
 */
export const UFT_FILE = /\.(mts|qfl|vbs|txt|xml|usr)$/i;

/** Limits of what one upload or one checkout may hold. */
export const UFT_LIMITS = {
	files: 5_000,
	/** Characters of one file. A UFT action script is seldom more than a few hundred lines. */
	fileChars: 2_000_000,
	/** Characters of all files together. */
	totalChars: 40_000_000
} as const;

/** One file of a UFT source, its path relative to the folder that was uploaded or checked out. */
export interface UftFile {
	path: string;
	text: string;
}

/** What a UFT test drives: SAP GUI for Windows (becomes WebGUI), Fiori in a browser, or neither. */
export type UftTarget = 'sapgui' | 'fiori' | 'mixed' | 'other';

export type UftSourceKind = 'upload' | 'git';

/** One UFT test of a source, as the page lists it. */
export interface UftTestSummary {
	/** The test's folder, relative to the source. Also its key. */
	path: string;
	name: string;
	target: UftTarget;
	actions: string[];
	/** Statements that do something (no comments, declarations or blank lines). */
	statements: number;
	/** Statements turned into Playwright code. */
	translated: number;
	/** What the import would write, or wrote before. */
	plan: string;
	spec: string;
	/** Where the test was imported before, when it was. */
	imported?: UftMigration;
}

/** How far an imported UFT test has come towards replacing the UFT test. */
export interface UftMigration {
	spec: string;
	/** Steps still marked for a person: UFT statements that were not translated. */
	open: number;
	/** The test is still `test.fixme`. */
	fixme: boolean;
	/** The name in the "checked by" comment, empty when nobody has put theirs in yet. */
	reviewer: string;
	lastStatus?: string;
	/** Consecutive passes, counted from the newest run back. */
	streak: number;
	/** Passes in a row after which the UFT test can be retired. */
	target: number;
}

export interface UftScanResult {
	source: UftSourceKind;
	/** For Git: the repository's host and branch, and the commit that was read. */
	origin?: string;
	tests: UftTestSummary[];
	/** Object repositories (XML) found in the source, used for every test. */
	repositories: string[];
	/** Things a person should know about the whole source, e.g. a binary repository without XML. */
	notes: string[];
}

/** What the import did with one test's two files. */
export type ImportedFile = 'written' | 'replaced' | 'kept';

export interface UftImportResult {
	path: string;
	name: string;
	plan: { file: string; outcome: ImportedFile };
	spec: { file: string; outcome: ImportedFile };
	translated: number;
	statements: number;
	notes: string[];
}

/**
 * Decodes a file as UFT writes it: UTF-16 or UTF-8 with a byte order mark, UTF-8 without one, and
 * otherwise Windows-1252 (older UFT versions save scripts in the system's ANSI code page).
 */
export function decodeUftFile(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe)
		return new TextDecoder('utf-16le').decode(bytes.subarray(2));
	if (bytes[0] === 0xfe && bytes[1] === 0xff)
		return new TextDecoder('utf-16be').decode(bytes.subarray(2));
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
		return new TextDecoder('utf-8').decode(bytes.subarray(3));
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder('windows-1252').decode(bytes);
	}
}
