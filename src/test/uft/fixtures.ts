import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UftFile } from '#lib/shared/uft.js';

/**
 * A UFT GUI test as UFT keeps it on disk (the text files of it): a flow (Action0) that calls a
 * SAP GUI action and a Fiori action, and the test's object repository exported as XML. Written
 * after UFT's own formats; the object repository follows the XML that the Object Repository
 * Manager exports.
 */
export const REPOSITORY_XML = readFileSync(resolve(import.meta.dirname, 'repository.xml'), 'utf8');

const FLOW = [
	'RunAction "Create order [VA01_Create]", oneIteration',
	'RunAction "Check in Fiori [VA01_Create]", oneIteration'
].join('\r\n');

export const SAP_GUI_ACTION = [
	"' Create a standard order",
	'SAPGuiSession("Session").SAPGuiWindow("SAP Easy Access").SAPGuiOKCode("OKCode").Set "/nva01"',
	'SAPGuiSession("Session").SAPGuiWindow("SAP Easy Access").SendKey ENTER',
	'With SAPGuiSession("Session").SAPGuiWindow("Create Sales Documents")',
	'\t.SAPGuiEdit("Order Type").Set DataTable("OrderType", dtGlobalSheet)',
	'\t.SAPGuiEdit("Sales Organization").Set _',
	'\t\t"1010"',
	'\t.SendKey ENTER',
	'End With',
	'SAPGuiSession("Session").SAPGuiWindow("Create Standard Order").SAPGuiComboBox("Shipping Conditions").Select "01"',
	'SAPGuiSession("Session").SAPGuiWindow("Create Standard Order").SAPGuiButton("Save").Click',
	'SAPGuiSession("Session").SAPGuiWindow("Create Standard Order").SAPGuiStatusBar("StatusBar").CheckProperty "messagetype", "S"',
	'orderNo = SAPGuiSession("Session").SAPGuiWindow("Create Standard Order").SAPGuiStatusBar("StatusBar").GetROProperty("text")',
	'If orderNo = "" Then',
	'\tReporter.ReportEvent micFail, "Order", "no number"',
	'End If',
	'Wait 2'
].join('\r\n');

const FIORI_ACTION = [
	'Browser("Fiori").Navigate "https://s4.example.com/sap/bc/ui2/flp#SalesOrder-manage"',
	'Browser("Fiori").Page("Manage Sales Orders").SAPUIButton("Go").Click',
	'Browser("Fiori").Page("Manage Sales Orders").WebEdit("Search").Set Parameter("OrderNumber")',
	'CheckOrder "4711"'
].join('\r\n');

const LIBRARY = ['Function CheckOrder(number)', '\tCheckOrder = True', 'End Function'].join('\r\n');

/** The test as a source: under `root` (e.g. the folder the person uploaded). */
export function uftSource(root = 'UFT/Sales/VA01_Create'): UftFile[] {
	return [
		{ path: `${root}/Action0/Script.mts`, text: FLOW },
		{ path: `${root}/Action1/Script.mts`, text: SAP_GUI_ACTION },
		{ path: `${root}/Action2/Script.mts`, text: FIORI_ACTION },
		{ path: `${root}/ObjectRepository.xml`, text: REPOSITORY_XML },
		{ path: 'UFT/Libraries/orders.qfl', text: LIBRARY }
	];
}
