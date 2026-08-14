import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function dealBlackjackHand(page: Page, bet: number = 50) {
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.fill('#bet-amount', String(bet));
		await page.getByRole('button', { name: 'Deal' }).click();
		await page.locator('#game-controls').waitFor({ state: 'visible' });

		const newRoundButton = page.getByRole('button', { name: 'New Round' });
		const finished = await newRoundButton.isVisible().catch(() => false);
		if (!finished) return;

		await page.reload({ waitUntil: 'networkidle' });
	}

	throw new Error('Unable to reach player turn for testing');
}

type PublicGame = {
	path: string;
	rootSelector: string;
	balanceSelector: string;
	heading: string;
	metadataTarget: 'balance' | 'root';
	accountOnlyButtonSelector?: string;
	aiStatusSelector?: string;
	shouldAvoidProviderRequests: boolean;
	guestAiEnabled: boolean;
};

test.describe('public single-player games', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	const publicGames: PublicGame[] = [
		{
			path: '/games/poker',
			rootSelector: '#poker-root',
			balanceSelector: '#player-balance',
			heading: "Texas Hold'em Poker",
			metadataTarget: 'balance',
			accountOnlyButtonSelector: '#btn-ai-move',
			aiStatusSelector: '#ai-rival-status',
			shouldAvoidProviderRequests: true,
			guestAiEnabled: false,
		},
		{
			path: '/games/blackjack',
			rootSelector: '#blackjack-root',
			balanceSelector: '#player-balance',
			heading: 'Blackjack',
			metadataTarget: 'root',
			accountOnlyButtonSelector: '#btn-ai-rival',
			aiStatusSelector: '#ai-rival-status',
			shouldAvoidProviderRequests: true,
			guestAiEnabled: true,
		},
		{
			path: '/games/baccarat',
			rootSelector: '#baccarat-root',
			balanceSelector: '#chip-balance',
			heading: 'Baccarat',
			metadataTarget: 'root',
			shouldAvoidProviderRequests: false,
			guestAiEnabled: false,
		},
		{
			path: '/games/craps',
			rootSelector: '#craps-root',
			balanceSelector: '#chip-balance',
			heading: 'Craps',
			metadataTarget: 'root',
			accountOnlyButtonSelector: '#llm-advice-btn',
			shouldAvoidProviderRequests: false,
			guestAiEnabled: false,
		},
	];

	for (const game of publicGames) {
		test(`${game.path} renders in guest mode without sign-in`, async ({ page }) => {
			const providerRequests: string[] = [];
			page.on('request', (request) => {
				if (
					request.url().includes('api.openai.com') ||
					request.url().includes('generativelanguage.googleapis.com')
				) {
					providerRequests.push(request.url());
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
				if (game.guestAiEnabled) {
					await expect(page.locator(game.accountOnlyButtonSelector)).toBeEnabled();
				} else {
					await expect(page.locator(game.accountOnlyButtonSelector)).toBeDisabled();
				}
			}

			if (game.shouldAvoidProviderRequests) {
				await page.waitForLoadState('networkidle');
				if (game.accountOnlyButtonSelector && game.guestAiEnabled) {
					await expect(page.locator(game.accountOnlyButtonSelector)).toBeEnabled();
				} else if (game.accountOnlyButtonSelector) {
					await expect(page.locator(game.accountOnlyButtonSelector)).toBeDisabled();
				}
				if (!game.guestAiEnabled && game.aiStatusSelector) {
					await expect(page.locator(game.aiStatusSelector)).toContainText('Sign in');
				}
				expect(providerRequests).toEqual([]);
			}
		});
	}

	test('multiplayer poker lobby remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});

	test('public poker ignores persisted guest LLM opponent settings', async ({ page }) => {
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
	});

	test('public blackjack guests receive local advice without provider requests', async ({
		page,
	}) => {
		const providerRequests: string[] = [];
		page.on('request', (request) => {
			if (
				request.url().includes('api.openai.com') ||
				request.url().includes('generativelanguage.googleapis.com')
			) {
				providerRequests.push(request.url());
			}
		});

		await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/games\/blackjack$/);
		await expect(page.locator('#blackjack-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.locator('#btn-ai-rival')).toBeEnabled();

		await dealBlackjackHand(page, 50);
		await page.getByRole('button', { name: 'Ask AI Rival' }).click();
		await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
		await expect(page.locator('#ai-advice-reasoning')).not.toBeEmpty();
		await page.waitForLoadState('networkidle');

		expect(providerRequests).toEqual([]);
	});

	test('multiplayer poker room remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp/MP-ABC123', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});

	test('guest blackjack can complete a round without wallet settlement', async ({ page }) => {
		const settlementRequests: string[] = [];
		const runRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) {
				settlementRequests.push(request.url());
			}
			if (request.url().includes('/api/blackjack-runs')) {
				runRequests.push(request.url());
			}
		});

		await page.addInitScript(() => {
			Math.random = () => 0;
		});

		await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('#blackjack-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByText('Casual', { exact: true })).toBeVisible();
		await expect(page.getByTestId('ranked-blackjack-signin')).toBeVisible();
		await expect(page.getByTestId('ranked-blackjack-signin')).toHaveAttribute('href', '/signin');

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
		// the BLACKJACK outcome above and the no-wallet-settlement assertion below.
		await expect(page.locator('#player-balance')).toHaveText(/\$\d[\d,]*/);
		// Deterministically wait for network to settle before asserting no wallet
		// settlement requests fire, instead of a fixed sleep.
		await page.waitForLoadState('networkidle');
		expect(settlementRequests).toEqual([]);
		expect(runRequests).toEqual([]);
	});

	test('guest craps restores persisted local bankroll without wallet settlement', async ({
		page,
	}) => {
		const settlementRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) {
				settlementRequests.push(request.url());
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
		expect(settlementRequests).toEqual([]);
	});

	test('guest craps restores bankroll from shared helper when no session exists', async ({
		page,
	}) => {
		const settlementRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) {
				settlementRequests.push(request.url());
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
		expect(settlementRequests).toEqual([]);
	});

	test('guest baccarat can complete a round without wallet settlement', async ({ page }) => {
		const settlementRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) {
				settlementRequests.push(request.url());
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

		await page.waitForLoadState('networkidle');
		expect(settlementRequests).toEqual([]);
	});
});
