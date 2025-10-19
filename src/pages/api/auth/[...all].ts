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

	const auth = createAuth(db, env, baseURL);

	return auth.handler(context.request);
};
