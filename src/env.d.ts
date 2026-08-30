/// <reference types="@cloudflare/workers-types" />

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

declare namespace App {
	interface Locals {
		/**
		 * Request locale, resolved once by middleware (cookie →
		 * Accept-Language → English) before any early return.
		 */
		locale: import('./lib/i18n/locale').Locale;
		runtime: {
			env: Env;
			cf: CfProperties;
			ctx: ExecutionContext;
		};
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
