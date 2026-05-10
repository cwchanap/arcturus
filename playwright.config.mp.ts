import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Multiplayer (MP) E2E tests.
 *
 * Uses `wrangler dev` instead of `astro dev` because MP tests require
 * Durable Objects, which are only available through the Workers runtime.
 */
export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: [['list'], ['html', { open: 'never' }]],
	globalSetup: './e2e/global-setup.ts',
	use: {
		baseURL: 'http://localhost:2000',
		trace: 'on-first-retry',
		storageState: './e2e/.auth/user.json',
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],

	webServer: {
		command:
			'PUBLIC_E2E=1 bun run build && WRANGLER_LOG_PATH=.wrangler/logs npx wrangler dev --port 2000',
		url: 'http://localhost:2000',
		// Never reuse an existing server — MP tests require `wrangler dev` for
		// Durable Objects. Reusing a `bun run dev` or stale build would silently
		// skip DO-dependent code paths.
		reuseExistingServer: false,
		timeout: 120 * 1000,
	},
});
