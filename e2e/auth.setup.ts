/**
 * Authentication setup constants and utilities for Playwright tests.
 * The real product auth flow is Google-only; tests use a guarded bootstrap endpoint.
 */

export const TEST_USER = {
	email: 'e2e-test@arcturus.local',
	name: 'E2E Test User',
} as const;

export const TEST_USER_2 = {
	email: 'e2e-test-2@arcturus.local',
	name: 'E2E Test User 2',
} as const;

export const TEST_USERS = [
	{
		credentials: TEST_USER,
		authFile: 'user.json',
	},
	{
		credentials: TEST_USER_2,
		authFile: 'user-2.json',
	},
] as const;

export const AUTH_FILE = './e2e/.auth/user.json';
