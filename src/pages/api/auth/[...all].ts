import { createAuth } from '../../../lib/auth';
import type { APIRoute } from 'astro';

export const ALL: APIRoute = async (context) => {
	// Try to get runtime from context.locals first (production)
	const runtime = context.locals.runtime;
	let env = runtime?.env;
	let db: D1Database | null = env?.DB || null;

	// Fallback to mock D1 database (development) - only if we have a runtime context
	// During build, runtime won't be available, so skip this
	if (!db && import.meta.env.DEV && runtime) {
		try {
			const { getMockD1Database } = await import('../../../lib/mock-d1');
			db = await getMockD1Database();
			env = { DB: db, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET } as Env;
		} catch (error) {
			console.error('Error creating mock D1 database:', error);
		}
	}

	if (!db || !env) {
		return new Response('Database not configured', { status: 500 });
	}

	// Get the base URL from the request
	const url = new URL(context.request.url);
	const baseURL = `${url.protocol}//${url.host}`;

	const auth = createAuth(db, env, baseURL);

	return auth.handler(context.request);
};
