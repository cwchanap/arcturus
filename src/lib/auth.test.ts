import { describe, expect, test } from 'bun:test';
import { buildAuthConfig, getAuthPlugins, getRequiredAuthConfig } from './auth';

const drizzleDb = {} as Parameters<typeof buildAuthConfig>[0];

const completeEnv = {
	BETTER_AUTH_SECRET: 'test-better-auth-secret',
	GOOGLE_CLIENT_ID: 'test-google-client-id',
	GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
};

describe('auth configuration', () => {
	test('requires Better Auth and Google OAuth secrets', () => {
		expect(() => getRequiredAuthConfig({})).toThrow(
			'Missing required auth environment binding(s): BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET',
		);
	});

	test('returns normalized required auth config', () => {
		expect(getRequiredAuthConfig(completeEnv)).toEqual({
			betterAuthSecret: 'test-better-auth-secret',
			googleClientId: 'test-google-client-id',
			googleClientSecret: 'test-google-client-secret',
		});
	});

	test('builds Google-only Better Auth options', () => {
		const config = buildAuthConfig(drizzleDb, completeEnv, 'http://localhost:2000');

		expect(config.secret).toBe('test-better-auth-secret');
		expect(config.emailAndPassword).toEqual({ enabled: false });
		expect(config.socialProviders?.google?.clientId).toBe('test-google-client-id');
		expect(config.socialProviders?.google?.clientSecret).toBe('test-google-client-secret');
		expect(config.baseURL).toBe('http://localhost:2000');
		expect(config.trustedOrigins).toEqual(['http://localhost:2000']);
	});

	test('includes the E2E bootstrap plugin only when explicitly enabled', () => {
		const disabledConfig = buildAuthConfig(drizzleDb, completeEnv, undefined, []);
		expect(disabledConfig.plugins).toEqual([]);
	});

	test('getAuthPlugins installs the E2E bootstrap plugin when guarded env is present', () => {
		expect(getAuthPlugins(completeEnv).map((plugin) => plugin.id)).toEqual([]);
		expect(
			getAuthPlugins({
				...completeEnv,
				APP_ENV: 'test',
				ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}).map((plugin) => plugin.id),
		).toEqual(['e2e-auth-bootstrap']);
	});
});
