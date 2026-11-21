// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** The signed-in person (sign-in on, see lib/server/auth), or undefined. */
			user?: { id: string; name: string; role: 'admin' | 'member' };
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

// Makes this file a module so `declare global` augments instead of redeclaring.
// oxlint-disable-next-line unicorn/require-module-specifiers
export {};
