import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/svelte';

/** Better Auth in the browser, on this app's origin (/api/auth). Only used with sign-in on. */
export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [passkeyClient()] });
