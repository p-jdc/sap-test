// Checks the ALV grid reader (sap-plugin/webgui-grid.ts, helpers/webgui.ts) on a stand-in page.
// Its lsdata follows the grids of WebGUI screens captured on real systems
// (Hochfrequenz/sapwebgui.mcp, MIT): the grid table lists ColumnIDs and totalRows, headers are
// GuiTableColumn `<grid>/col<NAME>`, cells are GuiGridViewCell `<grid>/rowcol/row[r]/cell[c]`
// with the text in an inner field.
import { test, expect, type Page } from '../../sap-plugin';
import { expectGridRow, readGrid } from '../../helpers/webgui';

const GRID = 'wnd[0]/usr/cntlGRID1/shellcont/shell/shellcont[1]/shell';
const COLUMNS = ['LIGHT', 'VBELN', 'STATUSTXT'];

const lsdata = (value: unknown) => `lsdata='${JSON.stringify(value)}'`;

const header = (column: string) =>
	`<th ${lsdata({ x: 0, 17: { SID: `${GRID}/col${column}`, Type: 'GuiTableColumn' } })}
		role="columnheader"><span>${column} caption</span><span>Long ${column} caption</span></th>`;

// The SID path of a cell (not an XPath: the SID locators match it inside lsdata).
const cellSid = (row: number, index: number) =>
	[GRID, 'rowcol', `row[${row}]`, `cell[${index}]`].join('/');

const cell = (row: number, index: number, text: string) =>
	`<td ${lsdata({ x: 0, 7: { SID: cellSid(row, index), Type: 'GuiGridViewCell' } })}
		role="gridcell"><div><span ${lsdata({ x: 0, 1: 'FREETEXT', 5: text })} role="textbox">
		${text}</span></div></td>`;

const gridRow = (row: number, values: string[]) =>
	`<tr><td role="rowheader"></td>${values.map((text, index) => cell(row, index, text)).join('')}</tr>`;

const gridTable = (rows: string[][], totalRows = rows.length) => `<table ct="STCS" ${lsdata({
	x: 0,
	34: { id: 'C120', SID: GRID, Type: 'GuiGridView', ColumnIDs: COLUMNS, totalRows, visibleRows: 20 }
})}>
<thead><tr><th></th>${COLUMNS.map((column) => header(column)).join('')}</tr></thead>
<tbody>${rows.map((values, index) => gridRow(index + 1, values)).join('')}</tbody>
</table>`;

// `later` rows wait in a <template>, outside the document, until a test moves them into the grid.
const gridPage = (
	rows: string[][],
	totalRows = rows.length,
	later: string[][] = []
) => `<!doctype html><html><body>
${gridTable(rows, totalRows)}
<template id="later">${later.map((values, index) => gridRow(rows.length + index + 1, values)).join('')}</template>
</body></html>`;

const ROWS = [
	['', '4711', 'Completed'],
	['', '4712', 'In process']
];

async function showGrid(page: Page, rows = ROWS, totalRows?: number, later?: string[][]) {
	await page.setContent(gridPage(rows, totalRows, later));
}

test('readGrid reads the drawn rows by technical column name', async ({ page }) => {
	await showGrid(page, ROWS, 57);
	const grid = await readGrid(page, GRID);
	expect(grid.columns).toEqual(COLUMNS);
	expect(grid.totalRows).toBe(57);
	expect(grid.rows.map((row) => row.values)).toEqual([
		{ LIGHT: '', VBELN: '4711', STATUSTXT: 'Completed' },
		{ LIGHT: '', VBELN: '4712', STATUSTXT: 'In process' }
	]);
});

test('readGrid: a row gives the locator of its cell in a column', async ({ page }) => {
	await showGrid(page);
	const grid = await readGrid(page, GRID);
	const second = grid.rows.find((row) => row.values.VBELN === '4712');
	await expect(second!.cell('STATUSTXT')).toHaveText('In process');
	await expect(page.locateSID(`${GRID}/rowcol/row[2]/cell[1]`)).toHaveText('4712');
	expect(() => second!.cell('NETWR')).toThrow(
		'The grid has no column "NETWR"; its columns are LIGHT, VBELN, STATUSTXT'
	);
});

test('readGrid of an empty grid has columns and no rows', async ({ page }) => {
	await showGrid(page, []);
	const grid = await readGrid(page, GRID);
	expect(grid.columns).toEqual(COLUMNS);
	expect(grid.rows).toEqual([]);
	expect(grid.totalRows).toBe(0);
});

test('expectGridRow waits for a row with these values', async ({ page }) => {
	await showGrid(page, [ROWS[0]], undefined, [ROWS[1]]);
	await expectGridRow(page, GRID, { VBELN: '4711', STATUSTXT: 'Completed' });
	await expectGridRow(page, GRID, { STATUSTXT: /^Compl/ });
	// A string is the whole cell text, not a part of it.
	await expect(expectGridRow(page, GRID, { STATUSTXT: 'Compl' }, { timeout: 500 })).rejects.toThrow(
		/grid .* shows a row with/
	);

	await page.evaluate(() =>
		setTimeout(() => {
			const later = document.querySelector('template')!;
			document.querySelector('tbody')!.append(later.content.cloneNode(true));
		}, 300)
	);
	await expectGridRow(page, GRID, { VBELN: '4712', STATUSTXT: 'In process' });
});

test('expectGridRow waits for a grid that is drawn later, and names a grid it never finds', async ({
	page
}) => {
	// The grid comes 1.5 s late, longer than one read of it waits: SAP is still answering.
	await page.setContent(
		`<!doctype html><html><body><div id="screen"></div><template>${gridTable([ROWS[0]])}</template></body></html>`
	);
	await page.evaluate(() =>
		setTimeout(() => {
			const later = document.querySelector('template')!;
			document.getElementById('screen')!.append(later.content.cloneNode(true));
		}, 1_500)
	);
	await expectGridRow(page, GRID, { VBELN: '4711' });

	await expect(
		expectGridRow(
			page,
			'wnd[0]/usr/cntlNOGRID/shellcont/shell',
			{ VBELN: '4711' },
			{ timeout: 2_500 }
		)
	).rejects.toThrow(/\(not read\)/);
});

test('expectGridRow needs a value to look for: an empty one would match any row', async ({
	page
}) => {
	await page.setContent('<p>No grid</p>');
	await expect(expectGridRow(page, GRID, {})).rejects.toThrow(
		'expectGridRow needs at least one column value to look for'
	);
});
