import { chromium, type FullConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Global setup that runs once before all tests.
 * Creates test user if needed and signs in with the test account, then saves the authentication state.
 */
async function globalSetup(_config: FullConfig) {
	const authFile = path.join(__dirname, '.auth', 'user.json');

	// Test account credentials - dedicated for E2E testing
	const TEST_EMAIL = 'e2e-test@arcturus.local';
	const TEST_PASSWORD = 'PlaywrightTest123!';
	const TEST_NAME = 'E2E Test User';

	// eslint-disable-next-line no-console
	console.log('🔐 Setting up authentication for E2E tests...');

	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();

	try {
		// Navigate to signup page and create account
		await page.goto('http://localhost:2000/signup');

		// Fill in signup form
		await page.fill('input[name="name"]', TEST_NAME);
		await page.fill('input[name="email"]', TEST_EMAIL);
		await page.fill('input[name="password"]', TEST_PASSWORD);

		// Click signup button
		await page.click('button[type="submit"]');

		// Wait for navigation after signup
		await page.waitForURL('http://localhost:2000/', { timeout: 15000 });

		// Debug: Check the current page and look for any authentication indicators
		const currentUrl = page.url();
		console.log(`Current URL after signup: ${currentUrl}`);

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

		let authenticated = false;
		for (const { name, check } of authChecks) {
			try {
				const isVisible = await check();
				console.log(`✅ ${name}: ${isVisible ? 'Found' : 'Not found'}`);
				if (isVisible) {
					authenticated = true;
					break;
				}
			} catch (error) {
				console.log(
					`❌ ${name}: Error - ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
			}
		}

		if (!authenticated) {
			// Try signing in as fallback
			console.log('Signup might have failed, trying sign in...');
			await page.goto('http://localhost:2000/signin');
			await page.fill('input[name="email"]', TEST_EMAIL);
			await page.fill('input[name="password"]', TEST_PASSWORD);
			await page.click('button[type="submit"]');
			await page.waitForURL('http://localhost:2000/', { timeout: 10000 });

			// Re-check authentication
			for (const { name, check } of authChecks) {
				try {
					const isVisible = await check();
					console.log(`🔄 Post-signin ${name}: ${isVisible ? 'Found' : 'Not found'}`);
					if (isVisible) {
						authenticated = true;
						break;
					}
				} catch (error) {
					console.log(
						`❌ Post-signin ${name}: Error - ${error instanceof Error ? error.message : 'Unknown error'}`,
					);
				}
			}
		}

		if (!authenticated) {
			throw new Error(
				'Login verification failed - no user authentication indicators found after multiple attempts',
			);
		}

		// eslint-disable-next-line no-console
		console.log('✅ Authentication successful!');

		// Save authentication state
		await context.storageState({ path: authFile });
		// eslint-disable-next-line no-console
		console.log(`💾 Auth state saved to ${authFile}`);
	} catch (error) {
		console.error('❌ Authentication setup failed:', error);
		console.error(
			'\n⚠️  Manual setup required. Create the test account by running:',
			`\n   1. Start dev server: bun run dev`,
			`\n   2. Visit http://localhost:2000/signup`,
			`\n   3. Create account with:`,
			`\n      - Email: ${TEST_EMAIL}`,
			`\n      - Password: ${TEST_PASSWORD}`,
			`\n      - Name: ${TEST_NAME}\n`,
		);
		throw error;
	} finally {
		await context.close();
		await browser.close();
	}
}

export default globalSetup;
