import { describe, expect, test } from 'bun:test';
import type { APIRoute } from 'astro';
import { ALL } from '../pages/api/auth/[...all]';

// Minimal Astro APIContext shape — the handler only reads
// `context.locals.runtime.env` and `context.request.url`.
function makeContext(env: Record<string, unknown> | undefined) {
	return {
		locals: { runtime: env ? { env } : {} },
		request: new Request('http://localhost:2000/api/auth/signin'),
	} as unknown as Parameters<APIRoute>[0];
}

describe('auth API route', () => {
	test('returns 500 with a clear message when the DB binding is absent', async () => {
		const response = await ALL(makeContext(undefined));

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Database not configured');
	});

	test('returns 503 (not an opaque 500) when auth secrets are misconfigured', async () => {
		// DB present but required auth secrets missing/blank — getRequiredAuthConfig
		// throws inside createAuth. This must surface as a diagnosable 503 rather
		// than an uncaught exception that crashes the request.
		const response = await ALL(makeContext({ DB: {} }));

		expect(response.status).toBe(503);
		expect(await response.text()).toBe('Authentication is not configured');
	});
});
