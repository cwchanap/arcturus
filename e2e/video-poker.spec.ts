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

test.describe('Video Poker narrow layout', () => {
	test.use({
		storageState: { cookies: [], origins: [] },
		viewport: { width: 375, height: 800 },
	});

	test('keeps five card slots and hold overlays aligned without overlap', async ({ page }) => {
		await page.addInitScript(() => {
			Math.random = () => 0;
		});
		await gotoVideoPoker(page);
		await page.locator('#video-poker-action').click();

		const geometry = await page.locator('[data-card-index]').evaluateAll((buttons) =>
			buttons.map((button) => {
				const slot = button.parentElement?.querySelector<HTMLElement>('[data-card-slot]');
				const card = slot?.querySelector<HTMLElement>('[data-card-face]:not(.hidden)');
				const overlay = button.getBoundingClientRect();
				const cardRect = card?.getBoundingClientRect();
				return {
					overlay: {
						left: overlay.left,
						right: overlay.right,
						top: overlay.top,
						bottom: overlay.bottom,
						width: overlay.width,
						height: overlay.height,
					},
					card: cardRect
						? {
								left: cardRect.left,
								right: cardRect.right,
								top: cardRect.top,
								bottom: cardRect.bottom,
								width: cardRect.width,
								height: cardRect.height,
							}
						: null,
				};
			}),
		);

		expect(geometry).toHaveLength(5);
		for (const { overlay, card } of geometry) {
			expect(card).not.toBeNull();
			expect(Math.abs(overlay.left - card!.left)).toBeLessThanOrEqual(1);
			expect(Math.abs(overlay.top - card!.top)).toBeLessThanOrEqual(1);
			expect(Math.abs(overlay.width - card!.width)).toBeLessThanOrEqual(1);
			expect(Math.abs(overlay.height - card!.height)).toBeLessThanOrEqual(1);
		}
		for (let index = 1; index < geometry.length; index += 1) {
			expect(geometry[index - 1].card!.right).toBeLessThanOrEqual(geometry[index].card!.left + 1);
		}
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
			const expectedBalance = startingBalance + Number(commands[1].delta ?? 0);
			await expect(page.getByTestId('chip-balance')).toHaveText(expectedBalance.toLocaleString());
			await expect(page.locator('[data-chip-balance]').first()).toHaveText(
				`${expectedBalance.toLocaleString()} chips`,
			);
		} finally {
			await context.close();
		}
	});

	test('disables Retry and Reset while Retry is in flight', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedVideoPokerPage(browser, baseURL);
		let releaseRetry: (() => void) | undefined;
		const retryReleased = new Promise<void>((resolve) => {
			releaseRetry = resolve;
		});
		try {
			const startingBalance = Number(
				(await page.getByTestId('chip-balance').textContent())?.replace(/[^0-9]/g, '') ?? '0',
			);
			let requestCount = 0;
			await page.route('**/api/wallet/settle', async (route) => {
				requestCount += 1;
				if (requestCount === 1) {
					await route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: JSON.stringify({ error: 'offline' }),
					});
					return;
				}
				await retryReleased;
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ balance: startingBalance, duplicate: false }),
				});
			});

			await page.locator('#video-poker-action').click(); // Deal
			await page.locator('#video-poker-action').click(); // Draw + settlement
			await expect(page.locator('#video-poker-settlement-recovery')).toBeVisible();

			await page.locator('#video-poker-retry-settlement').click();
			await expect(page.locator('#video-poker-retry-settlement')).toBeDisabled();
			await expect(page.locator('#video-poker-reset-settlement')).toBeDisabled();
			releaseRetry?.();
			await expect(page.locator('#video-poker-settlement-recovery')).toBeHidden();
		} finally {
			releaseRetry?.();
			await context.close();
		}
	});
});
