import { describe, expect, test } from 'bun:test';
import {
	buildAuthConfig,
	getAuthPlugins,
	getRequiredAuthConfig,
	isNonBlankString,
	requireString,
} from './auth';

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

	test('reports only the single missing binding when the others are present', () => {
		expect(() =>
			getRequiredAuthConfig({ ...completeEnv, GOOGLE_CLIENT_SECRET: undefined }),
		).toThrow('Missing required auth environment binding(s): GOOGLE_CLIENT_SECRET');
	});

	test('treats whitespace-only secrets as missing', () => {
		expect(() =>
			getRequiredAuthConfig({
				BETTER_AUTH_SECRET: '   ',
				GOOGLE_CLIENT_ID: 'test-google-client-id',
				GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
			}),
		).toThrow('Missing required auth environment binding(s): BETTER_AUTH_SECRET');
	});

	test('isNonBlankString narrows only non-empty trimmed strings', () => {
		expect(isNonBlankString('ok')).toBe(true);
		expect(isNonBlankString('  spaced  ')).toBe(true);
		expect(isNonBlankString('')).toBe(false);
		expect(isNonBlankString('   ')).toBe(false);
		expect(isNonBlankString(undefined)).toBe(false);
		expect(isNonBlankString(null)).toBe(false);
		expect(isNonBlankString(123)).toBe(false);
	});

	test('requireString throws a labelled error for blank input and narrows otherwise', () => {
		expect(() => requireString(undefined, 'X')).toThrow(
			'Missing required auth environment binding(s): X',
		);
		expect(() => requireString('  ', 'X')).toThrow(
			'Missing required auth environment binding(s): X',
		);
		// Returns the original (untrimmed) value when valid.
		expect(requireString(' secret ', 'X')).toBe(' secret ');
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
