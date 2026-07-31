import { expect, test, type Locator, type Page } from '@playwright/test';

const CANONICAL_GAME_TYPES = [
	'blackjack',
	'baccarat',
	'craps',
	'poker',
	'slots',
	'roulette',
	'keno',
] as const;

type CanonicalGameType = (typeof CANONICAL_GAME_TYPES)[number];

function zeroFilledGame(gameType: CanonicalGameType) {
	return {
		gameType,
		totalWins: 0,
		totalLosses: 0,
		handsPlayed: 0,
		winRate: 0,
		netProfit: 0,
		biggestWin: 0,
		winsRank: null,
	};
}

const POPULATED_STATISTICS = {
	summary: {
		totalHands: 25,
		totalWins: 10,
		totalLosses: 10,
		overallWinRate: 50,
		totalNetProfit: 600,
		mostPlayedGame: 'blackjack',
	},
	games: CANONICAL_GAME_TYPES.map((gameType) => {
		if (gameType === 'blackjack') {
			return {
				gameType,
				totalWins: 8,
				totalLosses: 8,
				handsPlayed: 20,
				winRate: 50,
				netProfit: 800,
				biggestWin: 400,
				winsRank: 3,
			};
		}
		if (gameType === 'baccarat') {
			return {
				gameType,
				totalWins: 2,
				totalLosses: 2,
				handsPlayed: 5,
				winRate: 50,
				netProfit: -200,
				biggestWin: 100,
				winsRank: 18,
			};
		}
		return zeroFilledGame(gameType);
	}),
};

const EMPTY_STATISTICS = {
	summary: {
		totalHands: 0,
		totalWins: 0,
		totalLosses: 0,
		overallWinRate: 0,
		totalNetProfit: 0,
		mostPlayedGame: null,
	},
	games: CANONICAL_GAME_TYPES.map(zeroFilledGame),
};

async function interceptStatistics(page: Page, fixture: unknown): Promise<void> {
	await page.route('**/api/profile/statistics', async (route) => {
		await route.fulfill({ json: fixture });
	});
}

function metricValue(scope: Locator, label: string): Locator {
	return scope
		.locator('dt')
		.filter({ hasText: new RegExp(`^${label}$`) })
		.locator('..')
		.locator('dd');
}

test.describe('Player Statistics Dashboard', () => {
	test('renders populated statistics in canonical game order with links', async ({ page }) => {
		await interceptStatistics(page, POPULATED_STATISTICS);
		await page.goto('/profile/statistics');

		const cards = page.locator('[data-testid^="statistics-card-"]');
		await expect(cards).toHaveCount(CANONICAL_GAME_TYPES.length);
		expect(
			await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
		).toEqual(CANONICAL_GAME_TYPES.map((gameType) => `statistics-card-${gameType}`));

		const summary = page.locator('[data-statistics-summary]');
		await expect(metricValue(summary, 'Total Hands')).toHaveText('25');
		await expect(metricValue(summary, 'Most Played')).toHaveText('Blackjack');
		await expect(metricValue(summary, 'Overall Win Rate')).toHaveText('50.0%');
		await expect(metricValue(summary, 'Net Profit')).toHaveText('+600 chips');

		const blackjack = page.getByTestId('statistics-card-blackjack');
		await expect(metricValue(blackjack, 'Hands Played')).toHaveText('20');
		await expect(metricValue(blackjack, 'Net Profit')).toHaveText('+800 chips');
		await expect(metricValue(blackjack, 'Wins Rank')).toHaveText('#3');
		await expect(blackjack.getByRole('link', { name: 'View Wins leaderboard' })).toHaveAttribute(
			'href',
			'/games/leaderboard?game=blackjack&metric=wins',
		);

		const baccarat = page.getByTestId('statistics-card-baccarat');
		await expect(metricValue(baccarat, 'Hands Played')).toHaveText('5');
		await expect(metricValue(baccarat, 'Net Profit')).toHaveText('−200 chips');
		await expect(metricValue(baccarat, 'Wins Rank')).toHaveText('#18');
		await expect(baccarat.getByRole('link', { name: 'Play Baccarat' })).toHaveAttribute(
			'href',
			'/games/baccarat',
		);
	});

	test('keeps the complete game grid beside the all-empty invitation', async ({ page }) => {
		await interceptStatistics(page, EMPTY_STATISTICS);
		await page.goto('/profile/statistics');

		await expect(page.getByText('Start playing to build your statistics.')).toBeVisible();
		await expect(page.locator('[data-testid^="statistics-card-"]')).toHaveCount(
			CANONICAL_GAME_TYPES.length,
		);
		await expect(page.locator('[data-statistics-status]')).toHaveText(
			CANONICAL_GAME_TYPES.map(() => 'Not played yet'),
		);
		await expect(page.locator('[data-statistics-wins-rank]')).toHaveText(
			CANONICAL_GAME_TYPES.map(() => 'Unranked'),
		);
	});

	test('recovers from a failed request and focuses the heading after retry', async ({ page }) => {
		let requestCount = 0;
		await page.route('**/api/profile/statistics', async (route) => {
			requestCount += 1;
			if (requestCount === 1) {
				await route.fulfill({ status: 500, json: { error: 'Statistics unavailable' } });
				return;
			}
			await route.fulfill({ json: POPULATED_STATISTICS });
		});

		await page.goto('/profile/statistics');

		const error = page.getByRole('alert');
		await expect(error).toBeVisible();
		await error.getByRole('button', { name: 'Try again' }).click();

		await expect(page.getByTestId('statistics-card-blackjack')).toBeVisible();
		await expect(error).toBeHidden();
		await expect(page.getByRole('heading', { name: 'Player Statistics', level: 1 })).toBeFocused();
	});

	test('supports mobile layout and representative keyboard navigation', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await interceptStatistics(page, POPULATED_STATISTICS);
		await page.goto('/profile/statistics');

		const blackjackRankLink = page
			.getByTestId('statistics-card-blackjack')
			.getByRole('link', { name: 'View Wins leaderboard' });
		await expect(blackjackRankLink).toBeVisible();

		await page.keyboard.press('Tab');
		await expect(page.locator('header a[href="/"]').first()).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(
			page.getByRole('banner').getByRole('link', { name: 'Profile', exact: true }),
		).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.locator('main a[href="/profile"]')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(blackjackRankLink).toBeFocused();

		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
});
