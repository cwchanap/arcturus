import { defineConfig, devices } from '@playwright/test';
import { AUTH_FILE } from './e2e/auth.setup';

/**
 * Playwright config for built-Worker E2E tests (test:e2e:mp, test:e2e:worker).
 *
 * Uses `wrangler dev` against `dist/` instead of `astro dev` because these
 * specs require Durable Objects, which are only available through the Workers
 * runtime. The calling scripts run `PUBLIC_E2E=1 bun run build` first so the
 * production build stays outside this server's startup timeout.
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
		storageState: AUTH_FILE,
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],

	webServer: {
		command: 'WRANGLER_LOG_PATH=.wrangler/logs npx wrangler dev --port 2000',
		url: 'http://localhost:2000',
		// Never reuse an existing server — these tests require `wrangler dev` for
		// Durable Objects. Reusing a `bun run dev` or stale build would silently
		// skip DO-dependent code paths.
		reuseExistingServer: false,
		timeout: 120 * 1000,
	},
});
