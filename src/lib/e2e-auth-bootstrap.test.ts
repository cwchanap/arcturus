import { describe, expect, test } from 'bun:test';
import {
	E2E_BOOTSTRAP_SECRET_HEADER,
	getE2eBootstrapSecret,
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
});
