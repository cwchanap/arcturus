import { expect, test } from '@playwright/test';

test.describe('public single-player games', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	const publicGames = [
		{
			path: '/games/poker',
			rootSelector: '#poker-root',
			balanceSelector: '#player-balance',
			heading: "Texas Hold'em Poker",
			metadataTarget: 'balance',
			accountOnlyButtonSelector: '#btn-ai-move',
		},
		{
			path: '/games/blackjack',
			rootSelector: '#blackjack-root',
			balanceSelector: '#player-balance',
			heading: 'Blackjack',
			metadataTarget: 'root',
			accountOnlyButtonSelector: '#btn-ai-rival',
		},
		{
			path: '/games/baccarat',
			rootSelector: '#baccarat-root',
			balanceSelector: '#chip-balance',
			heading: 'Baccarat',
			metadataTarget: 'root',
		},
		{
			path: '/games/craps',
			rootSelector: '#craps-root',
			balanceSelector: '#chip-balance',
			heading: 'Craps',
			metadataTarget: 'root',
			accountOnlyButtonSelector: '#llm-advice-btn',
		},
	] as const;

	for (const game of publicGames) {
		test(`${game.path} renders in guest mode without sign-in`, async ({ page }) => {
			await page.goto(game.path, { waitUntil: 'domcontentloaded' });

			await expect(page).toHaveURL(new RegExp(`${game.path}$`));
			await expect(page.getByRole('heading', { name: game.heading })).toBeVisible();
			await expect(page.locator(game.rootSelector)).toHaveAttribute('data-guest-mode', 'true');
			await expect(page.locator(game.balanceSelector)).toContainText('$1,000');
			await expect(page.getByText('Guest Balance')).toBeVisible();

			if (game.metadataTarget === 'balance') {
				const balance = page.locator(game.balanceSelector);
				await expect(balance).toHaveAttribute('data-balance', '1000');
				await expect(balance).toHaveAttribute('data-balance-available', 'true');
				await expect(balance).toHaveAttribute('data-guest-mode', 'true');
				await expect(balance).toHaveAttribute('data-user-id', 'anonymous');
			} else {
				const root = page.locator(game.rootSelector);
				await expect(root).toHaveAttribute('data-user-id', 'anonymous');
				await expect(root).toHaveAttribute('data-initial-balance', '1000');
			}

			if (game.accountOnlyButtonSelector) {
				await expect(page.locator(game.accountOnlyButtonSelector)).toBeDisabled();
			}
		});
	}

	test('multiplayer poker lobby remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});

	test('multiplayer poker room remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp/MP-ABC123', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});
});
