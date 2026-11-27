/**
 * Importing test cases from OpenText Octane (formerly ALM Octane): what the page and the server share.
 * The server side is src/lib/server/octane.ts.
 */

/**
 * The settings of the importer: the server's address (without `/ui` or `/api`), the shared space and
 * workspace, and an API access key. Only the app reads them: test runs and recordings never get them.
 */
export const OCTANE_SETTINGS = [
	'OCTANE_URL',
	'OCTANE_SHARED_SPACE',
	'OCTANE_WORKSPACE',
	'OCTANE_CLIENT_ID',
	'OCTANE_CLIENT_SECRET'
] as const;
export type OctaneSetting = (typeof OCTANE_SETTINGS)[number];

/** The kinds of Octane test the importer reads steps from. */
export type OctaneTestKind = 'manual' | 'gherkin';

/** One test case as the search lists it. */
export interface OctaneTestSummary {
	id: string;
	name: string;
	kind: OctaneTestKind;
	phase?: string;
	owner?: string;
	productAreas: string[];
	tags: string[];
	/** The test in Octane's own UI. */
	link: string;
	/** The plan imported from this test, relative to sap-tests, when there is one. */
	plan?: string;
	/** The test file imported from this test, relative to sap-tests, when there is one. */
	spec?: string;
}

export interface OctaneSearchResult {
	tests: OctaneTestSummary[];
	/** All tests that match, of which `tests` is one page. */
	total: number;
	offset: number;
}

/** What the import did with one test's two files. */
export type ImportedFile = 'written' | 'replaced' | 'kept';

export interface OctaneImportResult {
	id: string;
	name: string;
	plan: { file: string; outcome: ImportedFile };
	spec: { file: string; outcome: ImportedFile };
	/** Things a person should know about this test, e.g. a call step that names another test. */
	notes: string[];
}
