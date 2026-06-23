import { chromium, type FullConfig, type BrowserContext, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_USERS } from './auth.setup';
import { bootstrapTestUser } from './bootstrap-auth';

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

async function readChipBalanceFromPage(page: Page): Promise<number | null> {
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

async function provisionUser(
	context: BrowserContext,
	page: Page,
	baseURL: string,
	credentials: { email: string; name: string },
	authFile: string,
): Promise<void> {
	await bootstrapTestUser(context, baseURL, credentials);

	await page.goto(`${baseURL}/missions/daily`, { waitUntil: 'networkidle' });
	await page.locator('[data-chip-balance]').first().waitFor({ state: 'attached', timeout: 10000 });

	let currentBalance = (await readChipBalanceFromPage(page)) ?? 0;
	if (currentBalance < MINIMUM_E2E_CHIP_BALANCE) {
		for (let attempt = 0; attempt < 5; attempt++) {
			const delta = MINIMUM_E2E_CHIP_BALANCE - currentBalance;
			const response = await page.request.post(`${baseURL}/api/chips/update`, {
				data: { delta, gameType: 'blackjack', previousBalance: currentBalance },
			});
			if (response.ok()) {
				let refreshed: number | null = null;
				for (let r = 0; r < 3; r++) {
					await sleep(2100);
					await page.reload({ waitUntil: 'networkidle' });
					refreshed = await readChipBalanceFromPage(page);
					if (typeof refreshed === 'number') break;
				}
				if (typeof refreshed === 'number') {
					currentBalance = refreshed;
					break;
				}
				throw new Error('Chip balance update succeeded but could not be read back');
			}
			if (response.status() === 429) {
				const retryAfter = Number(response.headers()['retry-after'] ?? '2');
				await sleep((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000 + 100);
				currentBalance = (await readChipBalanceFromPage(page)) ?? currentBalance;
				continue;
			}
			if (response.status() === 409) {
				const data = (await response.json().catch(() => null)) as {
					currentBalance?: number;
				} | null;
				if (typeof data?.currentBalance === 'number') {
					currentBalance = data.currentBalance;
					continue;
				}
			}
			const errorText = await response.text().catch(() => '');
			throw new Error(`Failed to top up chip balance: ${response.status()} ${errorText}`);
		}
		if (currentBalance < MINIMUM_E2E_CHIP_BALANCE) {
			throw new Error(
				`Chip balance top-up did not reach minimum (${currentBalance} < ${MINIMUM_E2E_CHIP_BALANCE})`,
			);
		}
	}

	await context.storageState({ path: authFile });
}

async function globalSetup(config: FullConfig) {
	const authDir = path.join(process.cwd(), 'e2e', '.auth');
	if (!fs.existsSync(authDir)) {
		fs.mkdirSync(authDir, { recursive: true });
	}

	const projectBaseURL =
		config.projects?.[0]?.use?.baseURL && typeof config.projects[0].use.baseURL === 'string'
			? config.projects[0].use.baseURL
			: undefined;
	const baseURL = projectBaseURL || process.env.BASE_URL || 'http://localhost:2000';

	const browser = await chromium.launch();
	try {
		for (const user of TEST_USERS) {
			const context = await browser.newContext();
			const page = await context.newPage();
			const authFile = path.join(authDir, user.authFile);
			try {
				await provisionUser(context, page, baseURL, user.credentials, authFile);
			} catch (error: unknown) {
				console.error(`Global setup failed for ${user.credentials.email}`);
				console.error(`Base URL: ${baseURL}`);
				console.error(`Current URL: ${page.url()}`);
				try {
					await page.screenshot({
						path: path.join(authDir, `global-setup-${user.authFile}.error.png`),
						fullPage: true,
					});
				} catch {
					/* best-effort */
				}
				await context.close();
				throw error instanceof Error ? error : new Error(String(error));
			}
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

export default globalSetup;
