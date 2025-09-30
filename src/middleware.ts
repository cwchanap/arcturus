import { defineMiddleware } from 'astro:middleware';
import { createAuth } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
	const runtime = context.locals.runtime;
	
	if (runtime?.env?.DB) {
		// Get the base URL from the request
		const url = new URL(context.request.url);
		const baseURL = `${url.protocol}//${url.host}`;
		
		const auth = createAuth(runtime.env.DB, runtime.env, baseURL);
		
		try {
			const session = await auth.api.getSession({ 
				headers: context.request.headers 
			});
			context.locals.session = session;
			context.locals.user = session?.user;
		} catch (error) {
			console.error('Error getting session:', error);
			context.locals.session = null;
			context.locals.user = null;
		}
	}

	return next();
});
