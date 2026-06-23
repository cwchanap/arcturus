import { describe, expect, test } from 'bun:test';
import { buildAuthConfig, getRequiredAuthConfig } from './auth';

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
});
