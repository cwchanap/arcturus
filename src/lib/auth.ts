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

export function isNonBlankString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates and narrows a required auth secret to a non-blank `string`,
 * throwing a labelled error otherwise. `getRequiredAuthConfig` first
 * aggregates every missing key for a single diagnostic message, then uses
 * this helper to obtain a typed value without `as string` casts at call sites.
 */
export function requireString(value: string | undefined, label: string): string {
	if (!isNonBlankString(value)) {
		throw new Error(`Missing required auth environment binding(s): ${label}`);
	}
	return value;
}

export function getRequiredAuthConfig(env: AuthEnvInput) {
	const entries: Array<[string, string | undefined]> = [
		['BETTER_AUTH_SECRET', env.BETTER_AUTH_SECRET],
		['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID],
		['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET],
	];

	const missing = entries.filter(([, value]) => !isNonBlankString(value)).map(([key]) => key);

	if (missing.length > 0) {
		throw new Error(`Missing required auth environment binding(s): ${missing.join(', ')}`);
	}

	// Aggregation above guarantees none of these are blank; requireString now
	// only narrows the type to `string` (it never throws in practice).
	return {
		betterAuthSecret: requireString(env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET'),
		googleClientId: requireString(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID'),
		googleClientSecret: requireString(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET'),
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
