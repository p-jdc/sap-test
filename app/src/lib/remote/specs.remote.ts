import { query } from '$app/server';
import { z } from 'zod';
import { envStatus } from '#lib/server/env-file.js';
import { listSpecs, readSpecSource } from '#lib/server/specs.js';

export const getSpecs = query(() => listSpecs());

export const getSpecSource = query(z.string().min(1).max(500), (file) => readSpecSource(file));

export const getEnvStatus = query(() => envStatus());
