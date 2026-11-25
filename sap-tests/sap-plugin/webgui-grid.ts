// Reads a WebGUI ALV grid (GuiGridView, e.g. the result list of a report) into rows keyed by the
// technical column names. Like webgui.ts it reads WebGUI's `lsdata`, so the names do not depend on
// the logon language: the grid's lsdata lists its ColumnIDs, and each cell carries its SID
// `<grid>/rowcol/row[r]/cell[c]`, where `c` indexes ColumnIDs. This follows the grids in real WebGUI
// screens captured by Hochfrequenz/sapwebgui.mcp (MIT). Table controls (GuiTableControl) are not
// covered: no captured screen shows one.
import type { Locator, Page } from '@playwright/test';
import { ENGINES } from './engines';

const sid = (page: Page, path: string) => page.locator(`${ENGINES.sid}=${path}`);

export type GridRow = {
	/** Cell texts by technical column name, e.g. `{ VBELN: '4711', NETWR: '1.000,00' }`. */
	values: Record<string, string>;
	/** The cell of this row in `column` (technical name), to click or double-click it. */
	cell(column: string): Locator;
};

export type WebGUIGrid = {
	/** Technical column names in the grid's order. */
	columns: string[];
	/** The rows WebGUI has drawn, top to bottom. A long list draws only the rows on screen. */
	rows: GridRow[];
	/** How many rows the list has in all, drawn or not. */
	totalRows: number;
};

type RawGrid = {
	columns: string[];
	totalRows: number;
	rows: { values: Record<string, string>; sids: Record<string, string> }[];
};

/**
 * Reads the ALV grid with SID `gridSid`, e.g. 'wnd[0]/usr/cntlGRID1/shellcont/shell'. Waits for
 * the grid to exist, not for rows: check what you expect with `expectGridRow`, which retries.
 */
export async function readGrid(
	page: Page,
	gridSid: string,
	options?: { timeout?: number }
): Promise<WebGUIGrid> {
	const raw: RawGrid = await sid(page, gridSid).evaluate(
		(table) => {
			let columns: string[] = [];
			let totalRows = 0;
			const byRow = new Map<
				number,
				{ values: Record<string, string>; sids: Record<string, string> }
			>();
			for (const element of [table, ...table.querySelectorAll('[lsdata]')]) {
				let data: unknown;
				try {
					data = JSON.parse(element.getAttribute('lsdata') ?? '');
				} catch {
					continue;
				}
				if (typeof data !== 'object' || data === null) continue;
				// The SID and type sit in one of lsdata's entries (its number differs per control).
				const entries: unknown[] = Object.values(data);
				for (const info of entries) {
					if (typeof info !== 'object' || info === null || !('SID' in info) || !('Type' in info))
						continue;
					if (element === table && info.Type === 'GuiGridView') {
						if ('ColumnIDs' in info && Array.isArray(info.ColumnIDs))
							columns = info.ColumnIDs.filter((id): id is string => typeof id === 'string');
						if ('totalRows' in info && typeof info.totalRows === 'number')
							totalRows = info.totalRows;
					}
					if (info.Type !== 'GuiGridViewCell' || typeof info.SID !== 'string') continue;
					const position = /\/rowcol\/row\[(\d+)\]\/cell\[(\d+)\]$/.exec(info.SID);
					if (!position) continue;
					const row = Number(position[1]);
					const cell = Number(position[2]);
					const column = columns[cell] ?? `cell[${cell}]`;
					const entry = byRow.get(row) ?? { values: {}, sids: {} };
					entry.values[column] = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
					entry.sids[column] = info.SID;
					byRow.set(row, entry);
				}
			}
			// The cells come in document order, so the rows are in the order the grid shows them.
			const rows = [...byRow.values()];
			return { columns, totalRows, rows };
		},
		undefined,
		options
	);
	return {
		columns: raw.columns,
		totalRows: raw.totalRows,
		rows: raw.rows.map(({ values, sids }) => ({
			values,
			cell(column: string) {
				const cellSid = sids[column];
				if (!cellSid)
					throw new Error(
						`The grid has no column "${column}"; its columns are ${raw.columns.join(', ')}`
					);
				return sid(page, cellSid);
			}
		}))
	};
}
