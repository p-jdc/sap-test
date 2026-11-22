// Creates a locally trusted HTTPS certificate for dev and preview (see vite.config.ts) with mkcert.
// `mkcert -install` adds mkcert's local CA to the system and browser trust stores once (it may ask
// for your password); the certificate itself covers localhost only and stays in cert/ (gitignored).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

function run(args: string[]): boolean {
	const result = spawnSync('mkcert', args, { stdio: 'inherit' });
	if (result.error) {
		process.stderr.write(
			'mkcert not found. Install it first (macOS: brew install mkcert), then re-run bun run setup:cert.\n'
		);
		return false;
	}
	return result.status === 0;
}

mkdirSync('cert', { recursive: true });
const ok =
	run(['-install']) &&
	run([
		'-key-file',
		'cert/key.pem',
		'-cert-file',
		'cert/cert.pem',
		'localhost',
		'127.0.0.1',
		'::1'
	]);
process.exitCode = ok ? 0 : 1;
