// Downloads $metadata of every service in odata/metadata/options-per-service.json from the
// configured system (same variables as the sapApi fixture in sap-plugin/odata.ts). Then
// `bun run odata:generate` regenerates the clients and `bun run typecheck` shows which tests a
// changed service breaks; `git diff odata/` shows what changed.
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const services = JSON.parse(
	await readFile(new URL('odata/metadata/options-per-service.json', root), 'utf8')
);

const { SAP_API_URL: url, SAP_API_USERNAME: username, SAP_API_PASSWORD: password } = process.env;
if (!url || !username || !password) {
	console.error('Set SAP_API_URL, SAP_API_USERNAME and SAP_API_PASSWORD in .env.');
	process.exit(1);
}
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

for (const [file, { basePath }] of Object.entries(services)) {
	const metadataUrl = new URL(`${basePath}/$metadata`, url);
	if (process.env.SAP_CLIENT) metadataUrl.searchParams.set('sap-client', process.env.SAP_CLIENT);
	const response = await fetch(metadataUrl, {
		headers: { authorization, accept: 'application/xml' }
	});
	if (!response.ok) {
		console.error(`${metadataUrl.pathname}: HTTP ${response.status}`);
		process.exitCode = 1;
		continue;
	}
	await writeFile(new URL(file, root), await response.text());
	console.log(`updated ${file}`);
}
