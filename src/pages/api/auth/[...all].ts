import { createAuth } from '../../../lib/auth';
import type { APIRoute } from 'astro';

export const ALL: APIRoute = async (context) => {
	const runtime = context.locals.runtime;

	if (!runtime?.env?.DB) {
		return new Response('Database not configured', { status: 500 });
	}

	// Get the base URL from the request
	const url = new URL(context.request.url);
	const baseURL = `${url.protocol}//${url.host}`;

	const auth = createAuth(runtime.env.DB, runtime.env, baseURL);

	return auth.handler(context.request);
};
