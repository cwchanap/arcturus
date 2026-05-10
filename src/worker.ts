// Custom Cloudflare Worker entry point for Astro.
// Mirrors @astrojs/cloudflare/entrypoints/server.js and additionally re-exports
// Durable Object classes so wrangler can resolve them via bindings.

import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { Arcturus as ArcturusDO } from './server/mp/arcturus';

interface AstroManifest {
	[key: string]: unknown;
}

interface WorkerEnv {
	[key: string]: unknown;
}

export function createExports(manifest: AstroManifest) {
	const app = new App(manifest as ConstructorParameters<typeof App>[0]);
	const fetch = async (
		request: Request,
		env: WorkerEnv,
		context: ExecutionContext,
	): Promise<Response> => {
		return await handle(
			manifest as Parameters<typeof handle>[0],
			app,
			request,
			env as Parameters<typeof handle>[3],
			context,
		);
	};
	return { default: { fetch }, Arcturus: ArcturusDO };
}
