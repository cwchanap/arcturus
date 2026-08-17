import { expect, test } from '@playwright/test';

test.describe('Pai Gow Poker guest', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('plays a deterministic Push locally without wallet settlement', async ({ page }) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		await page.addInitScript(() => {
			localStorage.removeItem('pai-gow-poker-bankroll:anonymous');
			Math.random = () => 0;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });

		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000');

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await expect(page.getByTestId('chip-balance')).toHaveText('980');
		await expect(page.locator('[id^="pai-gow-player-slot-"][data-slot-state="card"]')).toHaveCount(
			7,
		);
		await expect(
			page.locator('[id^="pai-gow-dealer-high-slot-"][data-slot-state="facedown"]'),
		).toHaveCount(5);
		await expect(
			page.locator('[id^="pai-gow-dealer-low-slot-"][data-slot-state="facedown"]'),
		).toHaveCount(2);

		await page.getByTestId('auto-arrange-button').click();
		await expect(page.getByTestId('pai-gow-status')).toHaveText(
			'High: Straight Flush · Low: High Card',
		);
		await expect(page.locator('[data-testid="pai-gow-player-card-0"]')).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await expect(page.locator('[data-testid="pai-gow-player-card-1"]')).toHaveAttribute(
			'aria-pressed',
			'true',
		);

		await page.getByTestId('confirm-button').click();
		await expect(page.getByTestId('pai-gow-status')).toContainText('Push');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000');
		await expect(
			page.locator('[id^="pai-gow-dealer-high-slot-"][data-slot-state="card"]'),
		).toHaveCount(5);
		await expect(
			page.locator('[id^="pai-gow-dealer-low-slot-"][data-slot-state="card"]'),
		).toHaveCount(2);

		for (const [index, rank] of ['10', 'J', 'Q', 'K', 'A'].entries()) {
			await expect(
				page.locator(`#pai-gow-dealer-high-slot-${index} [data-rank]`).first(),
			).toHaveText(rank);
		}
		for (const [index, rank] of ['2', '3'].entries()) {
			await expect(
				page.locator(`#pai-gow-dealer-low-slot-${index} [data-rank]`).first(),
			).toHaveText(rank);
		}

		await page.getByTestId('new-round-button').click();
		await expect(page.getByTestId('new-round-button')).toBeHidden();
		await expect(page.getByTestId('pai-gow-status')).toHaveText('Choose a wager, then deal.');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000');
		await page.waitForLoadState('networkidle');
		expect(walletRequests).toEqual([]);
	});
});
