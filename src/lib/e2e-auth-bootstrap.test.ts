import { describe, expect, test } from 'bun:test';
import {
	E2E_BOOTSTRAP_SECRET_HEADER,
	getE2eBootstrapSecret,
	hasBootstrapAccount,
	isE2eAuthBootstrapRuntimeAllowed,
	isE2eBootstrapRequestAuthorized,
	shouldInstallE2eAuthBootstrap,
} from './e2e-auth-bootstrap';

describe('e2e auth bootstrap guards', () => {
	test('requires test or ci runtime, enable flag, and secret before installing', () => {
		expect(shouldInstallE2eAuthBootstrap({})).toBe(false);
		expect(shouldInstallE2eAuthBootstrap({ ENABLE_E2E_AUTH_BOOTSTRAP: 'true' })).toBe(false);
		expect(
			shouldInstallE2eAuthBootstrap({
				APP_ENV: 'test',
				ENABLE_E2E_AUTH_BOOTSTRAP: 'false',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(false);
		expect(
			shouldInstallE2eAuthBootstrap({
				ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(false);
		expect(
			shouldInstallE2eAuthBootstrap({
				APP_ENV: 'production',
				ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(false);
		expect(
			shouldInstallE2eAuthBootstrap({
				APP_ENV: 'test',
				ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(true);
		expect(
			shouldInstallE2eAuthBootstrap({
				APP_ENV: 'ci',
				ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(true);
	});

	test('allows bootstrap runtime only in test and ci app environments', () => {
		expect(isE2eAuthBootstrapRuntimeAllowed({})).toBe(false);
		expect(isE2eAuthBootstrapRuntimeAllowed({ APP_ENV: 'development' })).toBe(false);
		expect(isE2eAuthBootstrapRuntimeAllowed({ APP_ENV: 'production' })).toBe(false);
		expect(isE2eAuthBootstrapRuntimeAllowed({ APP_ENV: 'test' })).toBe(true);
		expect(isE2eAuthBootstrapRuntimeAllowed({ APP_ENV: 'ci' })).toBe(true);
	});

	test('normalizes blank bootstrap secrets to null', () => {
		expect(getE2eBootstrapSecret({ E2E_AUTH_BOOTSTRAP_SECRET: '   ' })).toBeNull();
		expect(getE2eBootstrapSecret({ E2E_AUTH_BOOTSTRAP_SECRET: 'secret' })).toBe('secret');
	});

	test('authorizes only the matching header secret', () => {
		const env = {
			ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
			E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
		};

		expect(isE2eBootstrapRequestAuthorized(new Headers(), env)).toBe(false);
		expect(
			isE2eBootstrapRequestAuthorized(new Headers({ [E2E_BOOTSTRAP_SECRET_HEADER]: 'wrong' }), env),
		).toBe(false);
		expect(
			isE2eBootstrapRequestAuthorized(
				new Headers({ [E2E_BOOTSTRAP_SECRET_HEADER]: 'secret' }),
				env,
			),
		).toBe(true);
	});

	test('rejects equal-length but mismatched secrets (exercises the XOR loop)', () => {
		// 'wrong' is a different length from 'secret', so it short-circuits before
		// the constant-time XOR. 'secr3t' is the same length, forcing the loop.
		const env = {
			ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
			E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
		};
		expect(
			isE2eBootstrapRequestAuthorized(
				new Headers({ [E2E_BOOTSTRAP_SECRET_HEADER]: 'secr3t' }),
				env,
			),
		).toBe(false);
	});

	test('hasBootstrapAccount only matches e2e-bootstrap provider accounts', () => {
		expect(hasBootstrapAccount(undefined)).toBe(false);
		expect(hasBootstrapAccount(null)).toBe(false);
		expect(hasBootstrapAccount([])).toBe(false);
		expect(hasBootstrapAccount([{ providerId: 'google', accountId: 'a' }])).toBe(false);
		// Mixed providers — bootstrap account present.
		expect(
			hasBootstrapAccount([
				{ providerId: 'google', accountId: 'a' },
				{ providerId: 'e2e-bootstrap', accountId: 'b' },
			]),
		).toBe(true);
		expect(hasBootstrapAccount([{ providerId: 'e2e-bootstrap', accountId: 'b' }])).toBe(true);
	});
});
