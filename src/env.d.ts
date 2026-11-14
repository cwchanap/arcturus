/// <reference types="@cloudflare/workers-types" />

// Bindings visible to the Worker. cloudflare:workers' `env` is typed as
// Cloudflare.Env (see @cloudflare/workers-types); augment it with this
// app's wrangler.toml bindings so `import { env } from 'cloudflare:workers'`
// and `locals.env` share one shape. `Env` below aliases it for call sites.
declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		BETTER_AUTH_SECRET: string;
		GOOGLE_CLIENT_ID: string;
		GOOGLE_CLIENT_SECRET: string;
		APP_ENV?: 'development' | 'test' | 'ci' | 'production';
		ENABLE_E2E_AUTH_BOOTSTRAP?: string;
		E2E_AUTH_BOOTSTRAP_SECRET?: string;
		MULTIPLAYER_POKER_ROOMS: DurableObjectNamespace;
		WORKER_ORIGIN?: string;
	}
}

type Env = Cloudflare.Env;

declare namespace App {
	interface Locals {
		/**
		 * Request locale, resolved once by middleware (cookie →
		 * Accept-Language → English) before any early return.
		 */
		locale: import('./lib/i18n/locale').Locale;
		/**
		 * Worker bindings, copied from cloudflare:workers by middleware.
		 * (Astro 6 / adapter v13 removed locals.runtime; middleware restores a
		 * plain, mockable seam so pages/API routes and tests read `locals.env`.)
		 */
		env?: Env;
		/** Cloudflare ExecutionContext, provided by the adapter. */
		cfContext?: ExecutionContext;
		session?: {
			user: {
				id: string;
				name: string;
				email: string;
				emailVerified: boolean;
				image?: string | null;
				chipBalance: number;
				createdAt: Date;
				updatedAt: Date;
			};
			session: {
				id: string;
				userId: string;
				expiresAt: Date;
				token: string;
				ipAddress?: string | null;
				userAgent?: string | null;
				createdAt: Date;
				updatedAt: Date;
			};
		} | null;
		user?: {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image?: string | null;
			chipBalance: number;
			createdAt: Date;
			updatedAt: Date;
		} | null;
	}
}
