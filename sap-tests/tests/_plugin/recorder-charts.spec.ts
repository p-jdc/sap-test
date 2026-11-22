// The recorder on the chart types of sap.viz: a data point is clicked in SAP's chart samples,
// and the recorded step must select the same data point in a fresh page. Needs internet access
// (SAP's public demo kit).
//
// By default the types that differ in how they draw: slices (Pie), value labels over the bars
// (StackedColumn), overlapping shapes (Bubble), a grid (Heatmap), nested areas (Treemap) and
// hundreds of points (TimeAxis). CHART_SAMPLES=all runs every sample of the demo kit.
import { test, expect, withSapMethods } from '../../sap-plugin';
import {
	installRecorder,
	recorderIdle,
	recorderReady,
	stepLocator
} from '../../sap-plugin/recorder';
import type { Page } from '../../sap-plugin';

const ALL =
	'Pie,Donut,Bubble,Scatter,Bar,Column,StackedColumn,StackedBar,Line,Area,Heatmap,Bullet,VerticalBullet,CombinedColumnLine,Waterfall,VerticalWaterfall,Radar,Treemap,TimeAxis,NegativeValues,Hierarchical';
const chosen = process.env.CHART_SAMPLES ?? 'Pie,StackedColumn,Bubble,Heatmap,Treemap,TimeAxis';
const samples = (chosen === 'all' ? ALL : chosen).split(',');

const sampleUrl = (sample: string) =>
	`https://ui5.sap.com/resources/sap/ui/documentation/sdk/index.html?sap-ui-xx-sample-id=sap.viz.sample.${sample}&sap-ui-xx-sample-lib=sap.viz&sap-ui-xx-sample-origin=.&sap-ui-xx-dk-origin=https://ui5.sap.com`;

// What each matching shape stands for: the texts of the record the chart keeps on it.
const pointsOf = (page: Page, selector: string) =>
	page.evaluate(
		(shapes) =>
			[...document.querySelectorAll(shapes)].map((shape) => {
				// oxlint-disable-next-line no-underscore-dangle -- D3's name
				const record: unknown = '__data__' in shape ? shape.__data__ : undefined;
				const texts = Object.entries(record ?? {}).filter(
					([name, value]) => typeof value === 'string' && !name.startsWith('_')
				);
				return Object.fromEntries(texts);
			}),
		selector
	);

async function openSample(page: Page, sample: string) {
	await page.goto(sampleUrl(sample));
	await expect(page.locator('.v-datapoint').first()).toBeVisible({ timeout: 30_000 });
	await page.waitForUI5();
}

/** Clicks like a person: at `spot`, after resting there, which is when the recorder describes it. */
async function clickAt(page: Page, spot: { x: number; y: number }) {
	await page.mouse.move(spot.x, spot.y);
	await recorderIdle(page);
	await page.mouse.click(spot.x, spot.y);
	await recorderIdle(page);
}

for (const sample of samples) {
	test(`${sample} chart: a clicked data point is recorded by its values and replays`, async ({
		browser
	}) => {
		const context = await browser.newContext();
		const recorded = await installRecorder(context);
		const page = withSapMethods(await context.newPage());
		await openSample(page, sample);
		await recorderReady(page);

		// A spot that is on the second shape itself: the middle of its box may belong to a
		// neighbour or to a value label.
		const shape = page.locator('.v-datapoint').nth(1);
		const spot = await shape.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const parts = [0.5, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9];
			for (const across of parts)
				for (const down of parts) {
					const [x, y] = [box.left + box.width * across, box.top + box.height * down];
					const hit = document.elementFromPoint(x, y);
					if (hit && element.contains(hit)) return { x, y };
				}
			return null;
		});
		expect(spot, 'no spot of the shape can be clicked').not.toBeNull();
		const clicked = (await pointsOf(page, '.v-datapoint'))[1];
		await clickAt(page, spot!);
		expect(await pointsOf(page, '.v-datapoint-selected')).toEqual([clicked]);

		const step = (await recorded()).at(-1);
		await context.close();
		expect(step?.problem).toBeUndefined();
		expect(step?.chartPoint).toEqual(clicked);

		const fresh = await browser.newContext();
		const again = withSapMethods(await fresh.newPage());
		await openSample(again, sample);
		await stepLocator(again, step!)!.click();
		await expect.poll(() => pointsOf(again, '.v-datapoint-selected')).toEqual([clicked]);
		await fresh.close();
	});
}

test('a click on the value label of a bar is recorded as its data point', async ({ browser }) => {
	const context = await browser.newContext();
	const recorded = await installRecorder(context);
	const page = withSapMethods(await context.newPage());
	await openSample(page, 'StackedColumn');
	await recorderReady(page);

	const label = page.locator('.v-datalabel').nth(1);
	const box = (await label.boundingBox())!;
	const clicked = (await pointsOf(page, '.v-datalabel'))[1];
	await clickAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
	expect(await pointsOf(page, '.v-datapoint-selected')).toEqual([clicked]);

	const step = (await recorded()).at(-1);
	await context.close();
	expect(step?.problem).toBeUndefined();
	expect(step?.chartPoint).toEqual(clicked);
});
