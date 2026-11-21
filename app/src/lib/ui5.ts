// Registers every UI5 web component the app uses. Imported once from the root layout
// (client-only: see routes/+layout.ts).
import { setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js';
import '@ui5/webcomponents/dist/Assets.js';
import '@ui5/webcomponents-fiori/dist/Assets.js';

import '@ui5/webcomponents/dist/Bar.js';
import '@ui5/webcomponents/dist/BusyIndicator.js';
import '@ui5/webcomponents/dist/Button.js';
import '@ui5/webcomponents/dist/Card.js';
import '@ui5/webcomponents/dist/CardHeader.js';
import '@ui5/webcomponents/dist/CheckBox.js';
import '@ui5/webcomponents/dist/Icon.js';
import '@ui5/webcomponents/dist/Input.js';
import '@ui5/webcomponents/dist/Label.js';
import '@ui5/webcomponents/dist/Link.js';
import '@ui5/webcomponents/dist/MessageStrip.js';
import '@ui5/webcomponents/dist/Option.js';
import '@ui5/webcomponents/dist/Panel.js';
import '@ui5/webcomponents/dist/ProgressIndicator.js';
import '@ui5/webcomponents/dist/SegmentedButton.js';
import '@ui5/webcomponents/dist/SegmentedButtonItem.js';
import '@ui5/webcomponents/dist/Select.js';
import '@ui5/webcomponents/dist/Switch.js';
import '@ui5/webcomponents/dist/Table.js';
import '@ui5/webcomponents/dist/TableCell.js';
import '@ui5/webcomponents/dist/TableHeaderCell.js';
import '@ui5/webcomponents/dist/TableHeaderRow.js';
import '@ui5/webcomponents/dist/TableRow.js';
import '@ui5/webcomponents/dist/Tag.js';
import '@ui5/webcomponents/dist/Text.js';
import '@ui5/webcomponents/dist/Title.js';
import '@ui5/webcomponents/dist/Toast.js';
import '@ui5/webcomponents-fiori/dist/IllustratedMessage.js';
import '@ui5/webcomponents-fiori/dist/ShellBar.js';
import '@ui5/webcomponents-fiori/dist/ShellBarSpacer.js';
import '@ui5/webcomponents-fiori/dist/SideNavigation.js';
import '@ui5/webcomponents-fiori/dist/SideNavigationItem.js';

import '@ui5/webcomponents-icons/dist/accept.js';
import '@ui5/webcomponents-icons/dist/add.js';
import '@ui5/webcomponents-icons/dist/action-settings.js';
import '@ui5/webcomponents-icons/dist/locked.js';
import '@ui5/webcomponents-icons/dist/validate.js';
import '@ui5/webcomponents-icons/dist/alert.js';
import '@ui5/webcomponents-icons/dist/attachment.js';
import '@ui5/webcomponents-icons/dist/decline.js';
import '@ui5/webcomponents-icons/dist/document.js';
import '@ui5/webcomponents-icons/dist/history.js';
import '@ui5/webcomponents-icons/dist/home.js';
import '@ui5/webcomponents-icons/dist/menu2.js';
import '@ui5/webcomponents-icons/dist/inspect.js';
import '@ui5/webcomponents-icons/dist/lab.js';
import '@ui5/webcomponents-icons/dist/machine.js';
import '@ui5/webcomponents-icons/dist/media-play.js';
import '@ui5/webcomponents-icons/dist/media-pause.js';
import '@ui5/webcomponents-icons/dist/less.js';
import '@ui5/webcomponents-icons/dist/circle-task.js';
import '@ui5/webcomponents-icons/dist/play.js';
import '@ui5/webcomponents-icons/dist/process.js';
import '@ui5/webcomponents-icons/dist/record.js';
import '@ui5/webcomponents-icons/dist/refresh.js';
import '@ui5/webcomponents-icons/dist/stop.js';
import '@ui5/webcomponents-icons/dist/picture.js';
import '@ui5/webcomponents-icons/dist/video.js';
import '@ui5/webcomponents-icons/dist/syntax.js';
import '@ui5/webcomponents-icons/dist/journey-arrive.js';
import '@ui5/webcomponents-icons/dist/navigation-right-arrow.js';
import '@ui5/webcomponents-icons/dist/sys-help.js';
import '@ui5/webcomponents-icons/dist/warning.js';
import '@ui5/webcomponents-icons/dist/error.js';

// The theme follows the operating system. `color-scheme` is set alongside it so everything that is
// not UI5 (scrollbars, the flow canvas, which styles itself with light-dark()) switches too.
const dark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
	document.documentElement.style.colorScheme = dark.matches ? 'dark' : 'light';
	void setTheme(dark.matches ? 'sap_horizon_dark' : 'sap_horizon');
}
applyTheme();
dark.addEventListener('change', applyTheme);
