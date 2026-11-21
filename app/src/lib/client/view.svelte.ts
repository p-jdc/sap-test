// The app speaks plain language by default. People who write the tests switch on "Technical
// details" in the top bar to also see file names, code, locators and logs; the choice is kept in
// this browser.
//
// "Show browser" opens a browser window for every test run started from this browser, so a person
// can watch the test work. Without it tests run unseen.
const TECHNICAL = 'sap-test-lab.technical';
const SHOW_BROWSER = 'sap-test-lab.show-browser';

function stored(key: string): boolean {
	try {
		return localStorage.getItem(key) === '1';
	} catch {
		// Storage can be blocked (private window); the switch then lasts for this page only.
		return false;
	}
}

function store(key: string, on: boolean) {
	try {
		localStorage.setItem(key, on ? '1' : '0');
	} catch {
		// See stored().
	}
}

export const view = $state({
	technical: stored(TECHNICAL),
	showBrowser: stored(SHOW_BROWSER)
});

export function setTechnical(on: boolean) {
	view.technical = on;
	store(TECHNICAL, on);
}

export function setShowBrowser(on: boolean) {
	view.showBrowser = on;
	store(SHOW_BROWSER, on);
}
