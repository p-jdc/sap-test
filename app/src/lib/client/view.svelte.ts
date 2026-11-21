// The app speaks plain language by default. People who write the tests switch on "Technical
// details" in the top bar to also see file names, code, locators and logs; the choice is kept in
// this browser.
const KEY = 'sap-test-lab.technical';

function stored(): boolean {
	try {
		return localStorage.getItem(KEY) === '1';
	} catch {
		// Storage can be blocked (private window); the switch then lasts for this page only.
		return false;
	}
}

export const view = $state({ technical: stored() });

export function setTechnical(on: boolean) {
	view.technical = on;
	try {
		localStorage.setItem(KEY, on ? '1' : '0');
	} catch {
		// See stored().
	}
}
