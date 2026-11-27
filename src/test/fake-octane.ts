/**
 * A stand-in for the REST API of OpenText Octane, as `fetch`: it signs in with one API key, answers the tests
 * collection and each test's script, and notes every request.
 */
import { z } from 'zod';

export interface FakeTest {
	id: string;
	name: string;
	subtype: string;
	description?: string;
	script?: string;
	phase?: string;
}

export interface FakeOctane {
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	requests: { method: string; url: URL; cookie: string | null; body?: string }[];
	/** Refuse reference fields, as an older workspace without product_areas does. */
	basicFieldsOnly: boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});

export const FAKE_KEY = { clientId: 'importer', clientSecret: 's3cret' };

export function fakeOctane(tests: FakeTest[]): FakeOctane {
	const fake: FakeOctane = {
		requests: [],
		basicFieldsOnly: false,
		fetch: (input, init = {}) => {
			const url = new URL(input);
			const headers = new Headers(init.headers);
			const method = init.method ?? 'GET';
			const body = typeof init.body === 'string' ? init.body : undefined;
			fake.requests.push({ method, url, cookie: headers.get('Cookie'), ...(body ? { body } : {}) });
			if (url.pathname === '/authentication/sign_in') {
				const key = z.record(z.string(), z.string()).parse(JSON.parse(body ?? '{}'));
				if (key.client_id !== FAKE_KEY.clientId || key.client_secret !== FAKE_KEY.clientSecret)
					return Promise.resolve(json({ description: 'bad key' }, 401));
				return Promise.resolve(
					new Response(null, {
						headers: [
							['Set-Cookie', 'LWSSO_COOKIE_KEY=abc; Path=/; Secure; HttpOnly'],
							['Set-Cookie', 'OCTANE_USER=importer; Path=/']
						]
					})
				);
			}
			if (url.pathname === '/authentication/sign_out') return Promise.resolve(new Response(null));
			if (!headers.get('Cookie')?.includes('LWSSO_COOKIE_KEY=abc'))
				return Promise.resolve(json({ error_code: 'unauthorized' }, 401));
			const base = '/api/shared_spaces/1001/workspaces/1002/tests';
			const script = new RegExp(`^${base}/(\\d+)/script$`).exec(url.pathname);
			if (script) {
				const test = tests.find((t) => t.id === script[1]);
				return Promise.resolve(
					test ? json({ script: test.script ?? '' }) : json({ description: 'no such test' }, 404)
				);
			}
			if (url.pathname === base) {
				const fields = url.searchParams.get('fields') ?? '';
				if (fake.basicFieldsOnly && fields.includes('{'))
					return Promise.resolve(
						json(
							{ error_code: 'platform.unknown_field', description: 'Unknown field product_areas' },
							400
						)
					);
				const query = url.searchParams.get('query') ?? '';
				const ids = /id IN ([\d,]+)/.exec(query)?.[1]?.split(',');
				const id = /id EQ (\d+)/.exec(query)?.[1];
				const name = /name EQ \^\*(.*)\*\^/.exec(query)?.[1]?.toLowerCase();
				const match = tests.filter(
					(t) =>
						(!ids || ids.includes(t.id)) &&
						(!id || t.id === id) &&
						(!name || t.name.toLowerCase().includes(name)) &&
						(ids ? true : ['test_manual', 'gherkin_test'].includes(t.subtype))
				);
				const offset = Number(url.searchParams.get('offset') ?? 0);
				const limit = Number(url.searchParams.get('limit') ?? 100);
				return Promise.resolve(
					json({
						total_count: match.length,
						data: match.slice(offset, offset + limit).map((t) => {
							const entity = {
								type: 'test',
								id: t.id,
								name: t.name,
								subtype: t.subtype,
								description: t.description ?? null
							};
							if (!fields.includes('{')) return entity;
							return Object.assign(entity, {
								phase: t.phase ? { type: 'phase', id: 'p1', name: t.phase } : null,
								owner: { type: 'workspace_user', id: '7', full_name: 'Alex Example' },
								product_areas: {
									total_count: 1,
									data: [{ type: 'product_area', id: '3', name: 'Sales' }]
								},
								user_tags: { total_count: 0, data: [] }
							});
						})
					})
				);
			}
			return Promise.resolve(json({ description: 'not found' }, 404));
		}
	};
	return fake;
}
