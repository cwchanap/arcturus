import { expect, test } from '@playwright/test';

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
