import { createAuth } from '../../../lib/auth';
import type { APIRoute } from 'astro';

export const ALL: APIRoute = async (context) => {
	const runtime = context.locals.runtime;
	const env = runtime?.env;
	const db: D1Database | null = env?.DB || null;

	if (!db || !env) {
		return new Response('Database not configured', { status: 500 });
	}

	// Get the base URL from the request
	const url = new URL(context.request.url);
	const baseURL = `${url.protocol}//${url.host}`;

	let auth;
	try {
		auth = createAuth(db, env, baseURL);
	} catch (error) {
		// Misconfigured auth (e.g. missing BETTER_AUTH_SECRET / Google OAuth
		// secrets). Fail loudly *and* logged instead of an opaque 500, so the
		// failure mode is diagnosable.
		console.error('Auth configuration error:', error);
		return new Response('Authentication is not configured', { status: 503 });
	}

	return auth.handler(context.request);
};
