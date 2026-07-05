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

	test('guest blackjack can complete a round without calling chip sync', async ({ page }) => {
		const chipUpdateRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/chips/update')) {
				chipUpdateRequests.push(request.url());
			}
		});

		await page.addInitScript(() => {
			Math.random = () => 0;
		});

		await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('#blackjack-root')).toHaveAttribute('data-guest-mode', 'true');

		await page.locator('#bet-amount').fill('50');
		await page.getByRole('button', { name: 'Deal' }).click();
		await expect(page.locator('#game-controls')).toBeVisible();

		for (let i = 0; i < 6; i++) {
			if (await page.locator('#btn-new-round').isVisible()) break;
			if (await page.locator('#btn-stand').isEnabled()) {
				await page.locator('#btn-stand').click();
			} else if (await page.locator('#btn-hit').isEnabled()) {
				await page.locator('#btn-hit').click();
			} else {
				break;
			}
		}

		await expect(page.locator('#btn-new-round')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('#game-status')).toContainText('BLACKJACK');
		// Assert a valid currency string rather than an exact balance — the
		// exact dollar value is incidental to the deterministic shuffle and
		// would break on any shuffle refactor. The meaningful invariants are
		// the BLACKJACK outcome above and the no-chip-sync assertion below.
		await expect(page.locator('#player-balance')).toHaveText(/\$\d[\d,]*/);
		// Deterministically wait for network to settle before asserting no chip
		// sync requests fire, instead of a fixed sleep.
		await page.waitForLoadState('networkidle');
		expect(chipUpdateRequests).toEqual([]);
	});

	test('guest craps restores persisted local bankroll without chip sync', async ({ page }) => {
		const chipUpdateRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/chips/update')) {
				chipUpdateRequests.push(request.url());
			}
		});

		await page.addInitScript(() => {
			localStorage.setItem(
				'craps-session:anonymous',
				JSON.stringify({
					gameState: {
						phase: 'come-out',
						point: null,
						lastRoll: null,
						rollHistory: [],
						activeBets: [],
						chipBalance: 1025,
						rollCount: 0,
						settings: {
							minBet: 5,
							maxBet: 500,
							maxOddsMultiplier: 2,
							animationSpeed: 'normal',
							llmEnabled: false,
							soundEnabled: true,
						},
					},
					selectedChipAmount: 50,
				}),
			);
			// Also seed the shared bankroll key so both mechanisms agree.
			localStorage.setItem('craps-bankroll:anonymous', '1025');
		});

		await page.goto('/games/craps', { waitUntil: 'domcontentloaded' });

		await expect(page.locator('#craps-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.locator('#chip-balance')).toHaveText('$1,025');
		// Deterministically wait for network to settle before asserting no chip
		// sync requests fire, instead of a fixed sleep.
		await page.waitForLoadState('networkidle');
		expect(chipUpdateRequests).toEqual([]);
	});

	test('guest craps restores bankroll from shared helper when no session exists', async ({
		page,
	}) => {
		const chipUpdateRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/chips/update')) {
				chipUpdateRequests.push(request.url());
			}
		});

		await page.addInitScript(() => {
			// Only seed the shared bankroll key — no craps-session snapshot.
			localStorage.setItem('craps-bankroll:anonymous', '850');
		});

		await page.goto('/games/craps', { waitUntil: 'domcontentloaded' });

		await expect(page.locator('#craps-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.locator('#chip-balance')).toHaveText('$850');
		await page.waitForLoadState('networkidle');
		expect(chipUpdateRequests).toEqual([]);
	});

	test('guest baccarat can complete a round without calling chip sync', async ({ page }) => {
		const chipUpdateRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/chips/update')) {
				chipUpdateRequests.push(request.url());
			}
		});

		await page.goto('/games/baccarat', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('#baccarat-root')).toHaveAttribute('data-guest-mode', 'true');

		// Place a player bet (default chip is $50) and deal.
		await page.locator('[data-bet-type="player"]').click();
		await expect(page.locator('#deal-button')).toBeEnabled();
		await page.locator('#deal-button').click();

		// Baccarat round animates card-by-card; wait for the result overlay's
		// "NEW ROUND" button to appear as the round-completion signal.
		await expect(page.locator('#new-round-button')).toBeVisible({ timeout: 15000 });

		// Balance must have moved off the starting $1,000 after a settled round.
		const balanceText = await page.locator('#chip-balance').textContent();
		expect(balanceText).not.toBe('$1,000');

		await page.waitForLoadState('networkidle');
		expect(chipUpdateRequests).toEqual([]);
	});
});
