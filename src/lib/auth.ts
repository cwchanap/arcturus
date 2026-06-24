import { betterAuth } from 'better-auth';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import {
	e2eAuthBootstrapPlugin,
	shouldInstallE2eAuthBootstrap,
	type E2eBootstrapEnv,
} from './e2e-auth-bootstrap';

export type AuthEnvInput = Partial<
	Pick<Env, 'BETTER_AUTH_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>
>;

export function getRequiredAuthConfig(env: AuthEnvInput) {
	const missing = [
		['BETTER_AUTH_SECRET', env.BETTER_AUTH_SECRET],
		['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID],
		['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET],
	]
		.filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
		.map(([key]) => key);

	if (missing.length > 0) {
		throw new Error(`Missing required auth environment binding(s): ${missing.join(', ')}`);
	}

	return {
		betterAuthSecret: env.BETTER_AUTH_SECRET as string,
		googleClientId: env.GOOGLE_CLIENT_ID as string,
		googleClientSecret: env.GOOGLE_CLIENT_SECRET as string,
	};
}

export function buildAuthConfig(
	drizzleDb: ReturnType<typeof drizzle>,
	env: AuthEnvInput,
	baseURL?: string,
	plugins: BetterAuthPlugin[] = [],
): BetterAuthOptions {
	const authEnv = getRequiredAuthConfig(env);
	const authConfig: BetterAuthOptions = {
		database: drizzleAdapter(drizzleDb, {
			provider: 'sqlite',
		}),
		secret: authEnv.betterAuthSecret,
		emailAndPassword: {
			enabled: false,
		},
		socialProviders: {
			google: {
				clientId: authEnv.googleClientId,
				clientSecret: authEnv.googleClientSecret,
			},
		},
		plugins,
	};

	if (baseURL) {
		authConfig.baseURL = baseURL;
		authConfig.trustedOrigins = [baseURL];
	}

	return authConfig;
}

export function getAuthPlugins(env: AuthEnvInput & E2eBootstrapEnv): BetterAuthPlugin[] {
	return shouldInstallE2eAuthBootstrap(env) ? [e2eAuthBootstrapPlugin(env)] : [];
}

export function createAuth(db: D1Database, env: Env, baseURL?: string) {
	const drizzleDb = drizzle(db, { schema });
	return betterAuth(buildAuthConfig(drizzleDb, env, baseURL, getAuthPlugins(env)));
}

export type Auth = ReturnType<typeof createAuth>;
