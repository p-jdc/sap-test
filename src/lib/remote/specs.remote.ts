import { query } from '$app/server';
import { z } from 'zod';
import { envStatus } from '#lib/server/env-file.js';
import { listSpecs, readSpecSource } from '#lib/server/specs.js';
import { signInSystems } from '#lib/server/systems.js';

export const getSpecs = query(() => listSpecs());

/** The systems of sap-tests/systems.json, in its order: what the Tests page groups by. */
export const getSystems = query(() => signInSystems().map(({ id, title }) => ({ id, title })));

export const getSpecSource = query(z.string().min(1).max(500), (file) => readSpecSource(file));

export const getEnvStatus = query(() => envStatus());
