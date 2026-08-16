import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

const createIsolatedThreeCardShowdownPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'three-card-showdown-wallet',
		namePrefix: 'Three Card Showdown Wallet',
		navigate: async (page: Page) => {
			await page.goto('/games/three-card-showdown', { waitUntil: 'domcontentloaded' });
		},
	});

test.describe('Three-Card Showdown guest', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('guest plays a deterministic round locally without wallet requests', async ({ page }) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		// random=0 deals player 3♥4♥5♥ and dealer 6♥7♥8♥; the dealer's straight
		// flush beats the player's, so Play loses both wagers: ante 10 → -20 net.
		await page.addInitScript(() => {
			Math.random = () => 0;
		});
		await page.goto('/games/three-card-showdown', { waitUntil: 'domcontentloaded' });

		await expect(page.getByTestId('three-card-showdown-root')).toHaveAttribute(
			'data-guest-mode',
			'true',
		);
		await expect(page.getByTestId('chip-balance')).toContainText('1,000');

		await page.locator('[data-ante="10"]').click();
		await page.locator('#three-card-showdown-deal').click();

		await expect(page.getByTestId('chip-balance')).toContainText('990');
		await expect(
			page.locator('[id^="three-card-showdown-player-slot-"][data-slot-state="card"]'),
		).toHaveCount(3);
		await expect(
			page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="facedown"]'),
		).toHaveCount(3);

		await page.locator('#three-card-showdown-play').click();

		await expect(page.locator('#three-card-showdown-result')).toHaveText('Dealer wins · -20 net');
		await expect(page.getByTestId('chip-balance')).toContainText('980');
		await expect(
			page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="card"]'),
		).toHaveCount(3);
		expect(walletRequests).toEqual([]);
	});
});

test.describe('Three-Card Showdown wallet recovery', () => {
	test('failed settlement shows recovery and Retry reuses the exact command', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedThreeCardShowdownPage(browser, baseURL);
		try {
			const commands: Array<Record<string, unknown>> = [];
			const startingBalance = Number(
				(await page.getByTestId('chip-balance').textContent())?.replace(/[^0-9]/g, '') ?? '0',
			);

			await page.route('**/api/wallet/settle', async (route) => {
				const command = route.request().postDataJSON() as Record<string, unknown>;
				commands.push(command);
				if (commands.length === 1) {
					await route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: JSON.stringify({ error: 'offline' }),
					});
					return;
				}
				const delta = typeof command.delta === 'number' ? command.delta : 0;
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ balance: startingBalance + delta, duplicate: false }),
				});
			});

			await page.locator('#three-card-showdown-deal').click();
			await page.locator('#three-card-showdown-play').click();

			// After Deal → Play exactly one command was sent; recovery is visible
			// and New Round is blocked until settlement succeeds.
			expect(commands).toHaveLength(1);
			await expect(page.locator('#three-card-showdown-settlement-recovery')).toBeVisible();
			await expect(page.locator('#three-card-showdown-new-round')).toBeDisabled();

			await page.locator('#three-card-showdown-retry-settlement').click();

			// Retry resends the exact same command; recovery clears and New Round unblocks.
			expect(commands).toHaveLength(2);
			expect(commands[1]).toEqual(commands[0]);
			await expect(page.locator('#three-card-showdown-settlement-recovery')).toBeHidden();
			await expect(page.locator('#three-card-showdown-new-round')).toBeEnabled();

			// Both the local balance and the shared header balance adopt the authoritative value.
			const expectedBalance = startingBalance + Number(commands[1].delta ?? 0);
			await expect(page.getByTestId('chip-balance')).toHaveText(expectedBalance.toLocaleString());
			await expect(page.locator('[data-chip-balance]').first()).toHaveText(
				`${expectedBalance.toLocaleString()} chips`,
			);
		} finally {
			await context.close();
		}
	});
});
