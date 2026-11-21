import { test, expect } from '../../sap-plugin';
import { field, runTransaction } from '../../helpers/webgui';
import { requireEnv } from '../../helpers/env';

const ORDER_NUMBER = '4711';

test('display sales order (WebGUI)', async ({ page }) => {
	requireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
	await runTransaction(page, 'VA03');
	await field(page, 'VBAK-VBELN').fill(ORDER_NUMBER);
	await page.locateSID('wnd[0]/tbar[1]/btn[8]').click();
	await expect(field(page, 'VBAK-VBELN')).toHaveValue(ORDER_NUMBER);
});
