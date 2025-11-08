import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export function createAuth(db: D1Database, env: Env, baseURL?: string) {
	const drizzleDb = drizzle(db, { schema });

	// Get the secret from env, fallback to process.env for local development
	const secret =
		env.BETTER_AUTH_SECRET ||
		process.env.BETTER_AUTH_SECRET ||
		'development-secret-change-in-production';

	const authConfig: BetterAuthOptions = {
		database: drizzleAdapter(drizzleDb, {
			provider: 'sqlite',
		}),
		secret,
		emailAndPassword: {
			enabled: true,
			// For now, email verification is disabled. Before enabling this in production,
			// you must configure Better Auth's email verification flow and your email provider.
			requireEmailVerification: false,
		},
	};

	// Only configure baseURL if provided (for production)
	if (baseURL) {
		authConfig.baseURL = baseURL;
		authConfig.trustedOrigins = [baseURL];
	}

	return betterAuth(authConfig);
}

export type Auth = ReturnType<typeof createAuth>;
