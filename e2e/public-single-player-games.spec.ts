import { expect, test } from '@playwright/test';

test.describe('public single-player games', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	const publicGames = [
		{
			path: '/games/poker',
			rootSelector: '#poker-root',
			balanceSelector: '#player-balance',
			heading: "Texas Hold'em Poker",
		},
		{
			path: '/games/blackjack',
			rootSelector: '#blackjack-root',
			balanceSelector: '#player-balance',
			heading: 'Blackjack',
		},
		{
			path: '/games/baccarat',
			rootSelector: '#baccarat-root',
			balanceSelector: '#chip-balance',
			heading: 'Baccarat',
		},
		{
			path: '/games/craps',
			rootSelector: '#craps-root',
			balanceSelector: '#chip-balance',
			heading: 'Craps',
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
