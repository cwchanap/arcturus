import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export function createAuth(db: D1Database, env: Env, baseURL?: string) {
	const drizzleDb = drizzle(db, { schema });

	// Get the secret from env, fallback to process.env for local development
	const secret = env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET || 'development-secret-change-in-production';

	const authConfig: any = {
		database: drizzleAdapter(drizzleDb, {
			provider: 'sqlite',
		}),
		secret,
		emailAndPassword: {
			enabled: true,
		},
	};

	// Only configure baseURL if provided (for production)
	if (baseURL) {
		authConfig.baseURL = baseURL;
		authConfig.trustedOrigins = [baseURL];
	}

	// Configure social providers only if credentials are available
	const githubClientId = env.GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
	const githubClientSecret = env.GITHUB_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET;
	const googleClientId = env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
	const googleClientSecret = env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

	if (githubClientId && githubClientSecret) {
		authConfig.socialProviders = authConfig.socialProviders || {};
		authConfig.socialProviders.github = {
			clientId: githubClientId,
			clientSecret: githubClientSecret,
		};
	}

	if (googleClientId && googleClientSecret) {
		authConfig.socialProviders = authConfig.socialProviders || {};
		authConfig.socialProviders.google = {
			clientId: googleClientId,
			clientSecret: googleClientSecret,
		};
	}

	return betterAuth(authConfig);
}

export type Auth = ReturnType<typeof createAuth>;
