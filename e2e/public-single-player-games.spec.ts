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
			aiStatusSelector: '#ai-rival-status',
			shouldAvoidProfileLlmSettingsRequest: true,
		},
		{
			path: '/games/blackjack',
			rootSelector: '#blackjack-root',
			balanceSelector: '#player-balance',
			heading: 'Blackjack',
			metadataTarget: 'root',
			accountOnlyButtonSelector: '#btn-ai-rival',
			aiStatusSelector: '#ai-rival-status',
			accountOnlySettingsSelector: '#setting-use-llm',
			shouldAvoidProfileLlmSettingsRequest: true,
		},
		{
			path: '/games/baccarat',
			rootSelector: '#baccarat-root',
			balanceSelector: '#chip-balance',
			heading: 'Baccarat',
			metadataTarget: 'root',
			shouldAvoidProfileLlmSettingsRequest: false,
		},
		{
			path: '/games/craps',
			rootSelector: '#craps-root',
			balanceSelector: '#chip-balance',
			heading: 'Craps',
			metadataTarget: 'root',
			accountOnlyButtonSelector: '#llm-advice-btn',
			shouldAvoidProfileLlmSettingsRequest: false,
		},
	] as const;

	for (const game of publicGames) {
		test(`${game.path} renders in guest mode without sign-in`, async ({ page }) => {
			const profileLlmSettingsRequests: string[] = [];
			page.on('request', (request) => {
				if (request.url().includes('/api/profile/llm-settings')) {
					profileLlmSettingsRequests.push(request.url());
				}
			});

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

			if (game.accountOnlySettingsSelector) {
				await expect(page.locator(game.accountOnlySettingsSelector)).toBeDisabled();
			}

			if (game.shouldAvoidProfileLlmSettingsRequest) {
				await page.waitForLoadState('networkidle');
				await expect(page.locator(game.accountOnlyButtonSelector)).toBeDisabled();
				if (game.accountOnlySettingsSelector) {
					await expect(page.locator(game.accountOnlySettingsSelector)).toBeDisabled();
				}
				await expect(page.locator(game.aiStatusSelector)).toContainText('Sign in');
				expect(profileLlmSettingsRequests).toEqual([]);
			}
		});
	}

	test('multiplayer poker lobby remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});

	test('public poker ignores persisted guest LLM opponent settings', async ({ page }) => {
		const profileLlmSettingsRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/profile/llm-settings')) {
				profileLlmSettingsRequests.push(request.url());
			}
		});

		await page.addInitScript(() => {
			localStorage.setItem('poker_game_settings', JSON.stringify({ useLLMAI: true }));
		});

		await page.goto('/games/poker', { waitUntil: 'domcontentloaded' });
		await page.waitForLoadState('networkidle');

		await expect(page).toHaveURL(/\/games\/poker$/);
		await expect(page.locator('#poker-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.locator('#btn-ai-move')).toBeDisabled();
		await expect(page.locator('#ai-rival-status')).toContainText('Sign in');
		await expect(page.locator('#setting-use-llm-ai')).not.toBeChecked();
		await expect(page.locator('#setting-use-llm-ai')).toBeDisabled();
		await expect(page.locator('#llm-overlay')).toBeHidden();
		expect(profileLlmSettingsRequests).toEqual([]);
	});

	test('public blackjack ignores persisted guest LLM advisor settings', async ({ page }) => {
		const profileLlmSettingsRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/profile/llm-settings')) {
				profileLlmSettingsRequests.push(request.url());
			}
		});

		await page.addInitScript(() => {
			localStorage.setItem(
				'arcturus:blackjack:settings:anonymous',
				JSON.stringify({ useLLM: true }),
			);
		});

		await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
		await page.waitForLoadState('networkidle');

		await expect(page).toHaveURL(/\/games\/blackjack$/);
		await expect(page.locator('#blackjack-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.locator('#btn-ai-rival')).toBeDisabled();
		await expect(page.locator('#ai-rival-status')).toContainText('Sign in');
		await expect(page.locator('#setting-use-llm')).not.toBeChecked();
		await expect(page.locator('#setting-use-llm')).toBeDisabled();
		expect(profileLlmSettingsRequests).toEqual([]);
	});

	test('multiplayer poker room remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp/MP-ABC123', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});
});
