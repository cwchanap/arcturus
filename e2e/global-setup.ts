import { chromium, type FullConfig } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MINIMUM_E2E_CHIP_BALANCE = 1000;

function parseChipBalance(text: string): number | null {
	const match = text.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)/);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
}

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readChipBalanceFromPage(
	page: import('@playwright/test').Page,
): Promise<number | null> {
	const loc = page.locator('[data-chip-balance]');
	const count = await loc.count();
	for (let i = 0; i < count; i++) {
		const text = await loc
			.nth(i)
			.innerText()
			.catch(() => '');
		const parsed = parseChipBalance(text);
		if (typeof parsed === 'number') {
			return parsed;
		}
	}
	return null;
}

/**
 * Global setup that runs once before all tests.
 * Creates test user if needed and signs in with the test account, then saves the authentication state.
 */
async function globalSetup(config: FullConfig) {
	const authFile = path.join(process.cwd(), 'e2e', '.auth', 'user.json');
	const authDir = path.dirname(authFile);
	if (!fs.existsSync(authDir)) {
		fs.mkdirSync(authDir, { recursive: true });
	}

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

		// Verify we're logged in by checking for authenticated user elements
		const authChecks = [
			{
				name: 'Chip balance data attribute',
				check: () => page.locator('span[data-chip-balance]').isVisible(),
			},
			{ name: 'Dashboard button', check: () => page.locator('text=Dashboard').isVisible() },
			{ name: 'Play Now button', check: () => page.locator('text=Play Now').isVisible() },
			{ name: 'User name display', check: () => page.locator(`text=${TEST_NAME}`).isVisible() },
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

		await page.goto(`${baseURL}/missions/daily`, { waitUntil: 'networkidle' });
		await page
			.locator('[data-chip-balance]')
			.first()
			.waitFor({ state: 'attached', timeout: 10000 });

		let currentBalance = await readChipBalanceFromPage(page);
		if (typeof currentBalance !== 'number') {
			currentBalance = 0;
		}

		if (currentBalance < MINIMUM_E2E_CHIP_BALANCE) {
			for (let attempt = 0; attempt < 5; attempt++) {
				const delta = MINIMUM_E2E_CHIP_BALANCE - currentBalance;
				const response = await page.request.post(`${baseURL}/api/chips/update`, {
					data: {
						delta,
						gameType: 'blackjack',
						previousBalance: currentBalance,
					},
				});

				if (response.ok()) {
					await sleep(2100);
					await page.reload({ waitUntil: 'networkidle' });
					currentBalance = (await readChipBalanceFromPage(page)) ?? currentBalance;
					break;
				}

				if (response.status() === 429) {
					const retryAfter = Number(response.headers()['retry-after'] ?? '2');
					await sleep((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000 + 100);
					currentBalance = (await readChipBalanceFromPage(page)) ?? currentBalance;
					continue;
				}

				if (response.status() === 409) {
					// This parse/cast is intentionally minimal (we only need currentBalance). If E2E failures
					// become hard to debug, consider parsing a richer error shape (e.g. error/message/code)
					// and including it in the thrown error to surface more context in test logs.
					const data = (await response.json().catch(() => null)) as {
						currentBalance?: number;
					} | null;
					if (typeof data?.currentBalance === 'number') {
						currentBalance = data.currentBalance;
						continue;
					}
				}

				const errorText = await response.text().catch(() => '');
				throw new Error(`Failed to top up E2E chip balance: ${response.status()} ${errorText}`);
			}

			if (currentBalance < MINIMUM_E2E_CHIP_BALANCE) {
				throw new Error(
					`E2E chip balance top-up did not reach minimum (${currentBalance} < ${MINIMUM_E2E_CHIP_BALANCE})`,
				);
			}
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
