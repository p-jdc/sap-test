import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The systems table of this repository's test project (SAP and Ariba). */
const SYSTEMS_JSON = resolve(import.meta.dirname, '../../../sap-tests/systems.json');

/** Gives a stand-in test project (SAP_TESTS_DIR) this repository's systems table. */
export function copySystems(testsRoot: string) {
	copyFileSync(SYSTEMS_JSON, join(testsRoot, 'systems.json'));
}
