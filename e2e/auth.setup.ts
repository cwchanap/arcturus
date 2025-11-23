/**
 * Authentication setup constants and utilities for Playwright tests.
 * All tests will use these credentials via global setup.
 */

export const TEST_USER = {
	email: 'e2e-test@arcturus.local',
	password: 'PlaywrightTest123!',
	name: 'E2E Test User',
} as const;

/**
 * Path to the saved authentication state.
 * This is populated by global-setup.ts before tests run.
 */
export const AUTH_FILE = './e2e/.auth/user.json';
