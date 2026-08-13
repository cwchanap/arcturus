import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

async function gotoVideoPoker(page: Page): Promise<void> {
	await page.goto('/games/video-poker', { waitUntil: 'domcontentloaded' });
}

const createIsolatedVideoPokerPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'video-poker-wallet',
		namePrefix: 'Video Poker Wallet',
		navigate: gotoVideoPoker,
	});

test.describe('Video Poker guest', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('guest can Deal, hold, Draw once, and start New Round locally', async ({ page }) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		await page.addInitScript(() => {
			Math.random = () => 0;
		});
		await gotoVideoPoker(page);

		await expect(page.getByTestId('video-poker-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByTestId('chip-balance')).toContainText('1,000');
		await page.locator('[data-wager="2"]').click();
		await page.locator('#video-poker-action').click();
		await expect(page.locator('#video-poker-action')).toHaveText('Draw');

		const first = page.locator('[data-card-index="0"]');
		const third = page.locator('[data-card-index="2"]');
		const firstId = await first.getAttribute('data-card-id');
		const thirdId = await third.getAttribute('data-card-id');
		expect(firstId).toBeTruthy();
		expect(thirdId).toBeTruthy();

		await first.click();
		await third.click();
		await expect(first).toHaveAttribute('aria-pressed', 'true');
		await expect(third).toHaveAttribute('aria-pressed', 'true');
		await page.locator('#video-poker-action').click();

		await expect(page.locator('#video-poker-action')).toHaveText('New Round');
		await expect(first).toHaveAttribute('data-card-id', firstId!);
		await expect(third).toHaveAttribute('data-card-id', thirdId!);
		await expect(page.locator('#video-poker-result')).not.toBeEmpty();

		await page.locator('#video-poker-action').click();
		await expect(page.locator('#video-poker-action')).toHaveText('Deal');
		expect(walletRequests).toEqual([]);
	});
});

test.describe('Video Poker wallet recovery', () => {
	test('failed settlement shows recovery and Retry reuses the exact command', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedVideoPokerPage(browser, baseURL);
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

			await page.locator('#video-poker-action').click(); // Deal
			await page.locator('#video-poker-action').click(); // Draw + settlement

			await expect(page.locator('#video-poker-settlement-recovery')).toBeVisible();
			await expect(page.locator('#video-poker-retry-settlement')).toBeVisible();
			await expect(page.locator('#video-poker-reset-settlement')).toBeVisible();
			await expect(page.locator('#video-poker-action')).toHaveText('New Round');
			await expect(page.locator('#video-poker-action')).toBeDisabled();
			expect(commands).toHaveLength(1);

			await page.locator('#video-poker-retry-settlement').click();

			await expect(page.locator('#video-poker-settlement-recovery')).toBeHidden();
			await expect(page.locator('#video-poker-action')).toBeEnabled();
			expect(commands).toHaveLength(2);
			expect(commands[1]).toEqual(commands[0]);
		} finally {
			await context.close();
		}
	});
});
