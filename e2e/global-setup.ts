import { chromium, type FullConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Global setup that runs once before all tests.
 * Creates test user if needed and signs in with the test account, then saves the authentication state.
 */
async function globalSetup(config: FullConfig) {
	const authFile = path.join(__dirname, '.auth', 'user.json');

	// Test account credentials - dedicated for E2E testing
	const TEST_EMAIL = 'e2e-test@arcturus.local';
	const TEST_PASSWORD = 'PlaywrightTest123!';
	const TEST_NAME = 'E2E Test User';

	// Resolve baseURL from Playwright config or environment.
	// FullConfig exposes projects; use the first project's use.baseURL by convention.
	const projectBaseURL =
		config.projects?.[0]?.use?.baseURL && typeof config.projects[0].use.baseURL === 'string'
			? config.projects[0].use.baseURL
			: undefined;

	const baseURL = projectBaseURL || process.env.BASE_URL || 'http://localhost:2000';

	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();

	try {
		// Navigate to signup page and create account
		await page.goto(`${baseURL}/signup`);

		// Fill in signup form
		await page.fill('input[name="name"]', TEST_NAME);
		await page.fill('input[name="email"]', TEST_EMAIL);
		await page.fill('input[name="password"]', TEST_PASSWORD);

		// Click signup button
		await page.click('button[type="submit"]');

		// Wait for navigation after signup
		await page.waitForURL(`${baseURL}/`, { timeout: 15000 });

		// Multiple ways to verify we're logged in
		const authChecks = [
			{ name: 'Chip Balance text', check: () => page.locator('text=Chip Balance').isVisible() },
			{
				name: 'Chip balance data attribute',
				check: () => page.locator('span[data-chip-balance]').isVisible(),
			},
			{ name: 'Dashboard button', check: () => page.locator('text=Dashboard').isVisible() },
			{ name: 'Play Now button', check: () => page.locator('text=Play Now').isVisible() },
			{ name: 'User name display', check: () => page.locator(`text=${TEST_NAME}`).isVisible() },
			{
				name: 'Daily Mission link',
				check: () => page.locator('a[href="/missions/daily"]').isVisible(),
			},
		];

		// Helper to run the auth checks until one passes
		const verifyAuthenticated = async (): Promise<boolean> => {
			for (const { name: _name, check } of authChecks) {
				try {
					const isVisible = await check();
					if (isVisible) {
						return true;
					}
				} catch (_error) {
					// Silent failure, will try next check
					// (individual checks may fail if specific UI elements are not present)
				}
			}
			return false;
		};

		let authenticated = await verifyAuthenticated();

		if (!authenticated) {
			// Try signing in as fallback
			await page.goto(`${baseURL}/signin`);
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', TEST_PASSWORD);
			await page.click('button[type="submit"]');
			await page.waitForURL(`${baseURL}/`, { timeout: 10000 });

			// Re-check authentication using the shared helper
			authenticated = await verifyAuthenticated();
		}

		if (!authenticated) {
			throw new Error(
				'Login verification failed - no user authentication indicators found after multiple attempts',
			);
		}

		// Save authentication state
		await context.storageState({ path: authFile });
	} catch (error: unknown) {
		const currentUrl = page.url();
		console.error('Global setup signup/signin failed');
		console.error(`Base URL: ${baseURL}`);
		console.error(`Current URL: ${currentUrl}`);

		// Log any visible validation or error messages
		try {
			const errorMessages = await page
				.locator('text=/invalid|error|failed|required|already exists|already in use/i')
				.allInnerTexts();
			if (errorMessages.length > 0) {
				console.error('Validation / error messages detected on page:', errorMessages);
			}
		} catch {
			// Ignore locator/DOM failures in logging path
		}

		// Capture screenshot for debugging
		try {
			await page.screenshot({
				path: path.join(__dirname, '.auth', 'global-setup-signup-error.png'),
				fullPage: true,
			});
			console.error('Screenshot captured at .auth/global-setup-signup-error.png for debugging.');
		} catch {
			// Best-effort only
		}

		// Capture trace if desired (optional, best-effort)
		try {
			await context.tracing.start({ screenshots: true, snapshots: true });
			await context.tracing.stop({
				path: path.join(__dirname, '.auth', 'global-setup-signup-trace.zip'),
			});
			console.error('Trace captured at .auth/global-setup-signup-trace.zip for debugging.');
		} catch {
			// Ignore trace failures
		}

		// Fail-fast: ensure setup does not silently continue
		throw error instanceof Error ? error : new Error(`Global setup failed: ${String(error)}`);
	} finally {
		await context.close();
		await browser.close();
	}
}

export default globalSetup;
