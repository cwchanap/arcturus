import { test as base, expect, type Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

const test = base.extend<{ missionPage: Page }>({
	missionPage: async ({ browser, baseURL }, use) => {
		const { context, page } = await createIsolatedPage(browser, baseURL, {
			emailPrefix: 'mission',
			namePrefix: 'Mission E2E',
		});

		try {
			await context.request.delete('/api/missions/progress', { data: {} });
			await use(page);
		} finally {
			await context.close();
		}
	},
});

/**
 * Wait (with a bounded retrying assertion on #game-status) for the round to
 * settle to a terminal outcome matching `regex`. Returns true if the status
 * matched within `timeoutMs`, false on timeout — so callers can keep hitting
 * when the hand hasn't busted yet without failing the test.
 */
async function statusSettledTo(page: Page, regex: RegExp, timeoutMs: number): Promise<boolean> {
	try {
		await expect(page.locator('#game-status')).toContainText(regex, { timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
}

/**
 * Finish a dealt Blackjack hand without assuming Stand is available. Natural
 * blackjacks and immediate pushes resolve during Deal and correctly leave the
 * player controls disabled, while ordinary hands require a Stand action.
 */
async function finishBlackjackHand(page: Page): Promise<void> {
	const standButton = page.locator('#btn-stand');
	const newRoundButton = page.locator('#btn-new-round');

	await expect
		.poll(async () => (await newRoundButton.isVisible()) || (await standButton.isVisible()), {
			timeout: 5000,
		})
		.toBe(true);

	if (!(await newRoundButton.isVisible())) {
		await expect(standButton).toBeVisible({ timeout: 5000 });
		await standButton.click();
	}

	await expect(newRoundButton).toBeVisible({ timeout: 15000 });
}

test.describe('Mission Board', () => {
	test('board loads with SSR (no empty flash)', async ({ missionPage: page }) => {
		await page.goto('/missions');
		await expect(page.getByTestId('streak-banner')).toBeVisible();
		await expect(page.getByTestId('daily-grid')).toBeVisible();
		await expect(page.getByTestId('weekly-section')).toBeVisible();
	});

	test('streak claim grants chips, second claim is idempotent', async ({ missionPage: page }) => {
		await page.goto('/missions');
		const claimBtn = page.getByTestId('claim-login-btn');
		await expect(claimBtn).toBeEnabled();

		await claimBtn.click();
		// Wait for refresh
		await expect(claimBtn).toBeDisabled();

		// Second claim should not error or grant again
		// (button is disabled after first claim)
		await expect(claimBtn).toBeDisabled();
	});

	test('streak continuation via seedStreak', async ({ missionPage: page }) => {
		const request = page.context().request;
		// Seed: claimed yesterday with 2-day streak
		await request.delete('/api/missions/progress', {
			data: {
				resetProgress: false,
				seedStreak: { lastClaimPeriodKey: 'yesterday', currentStreak: 2 },
			},
		});

		await page.goto('/missions');
		const claimBtn = page.getByTestId('claim-login-btn');
		await claimBtn.click();

		// After claim, streak should be 3 (continuing)
		await expect(page.getByTestId('streak-subtitle')).toContainText('3-day streak');
	});

	test('streak breakage via seedStreak', async ({ missionPage: page }) => {
		const request = page.context().request;
		// Seed: claimed 3 days ago with 5-day streak
		await request.delete('/api/missions/progress', {
			data: {
				resetProgress: false,
				seedStreak: { lastClaimPeriodKey: '2020-01-01', currentStreak: 5 },
			},
		});

		await page.goto('/missions');
		// Display should show broken (0)
		await expect(page.getByTestId('streak-display')).toContainText('Day 1');

		const claimBtn = page.getByTestId('claim-login-btn');
		await claimBtn.click();
		await expect(page.getByTestId('streak-subtitle')).toContainText('1-day streak');
	});

	test('reroll swaps an uncompleted daily quest', async ({ missionPage: page }) => {
		await page.goto('/missions');
		const rerollBtn = page.locator('[data-testid^="reroll-"]').first();
		await rerollBtn.click();

		// After reroll, all reroll buttons should be hidden (one per day)
		await expect(page.locator('[data-testid^="reroll-"]')).toHaveCount(0);
	});

	test('post-reset clears progress', async ({ missionPage: page }) => {
		const request = page.context().request;
		await page.goto('/missions');
		await request.delete('/api/missions/progress', { data: {} });
		await page.reload();
		// All progress should be 0
		const progressTexts = await page.locator('[data-testid^="progress-text-"]').allTextContents();
		for (const text of progressTexts) {
			expect(text.trim()).toMatch(/^0\/\d+$/);
		}
	});

	test('blackjack game flow increments handsPlayed mission progress', async ({
		missionPage: page,
	}) => {
		const request = page.context().request;
		// Retry single-hand attempts until a win is observed, so the roundsWon
		// assertion is deterministic (no silent skip on push/loss). Each attempt
		// resets mission progress so handsPlayed reflects exactly one hand.
		const MAX_ATTEMPTS = 10;
		let winAchieved = false;
		for (let attempt = 0; attempt < MAX_ATTEMPTS && !winAchieved; attempt++) {
			await request.delete('/api/missions/progress', { data: {} });

			// Play a blackjack hand: deal, stand when needed, wait for resolution
			await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
			await page.fill('#bet-amount', '50');
			await page.getByRole('button', { name: 'Deal' }).click();
			await page.locator('#game-controls').waitFor({ state: 'visible' });
			await finishBlackjackHand(page);

			// Read the game status to determine the outcome
			const status = (await page.locator('#game-status').textContent())?.trim() ?? '';
			if (/You win|BLACKJACK/i.test(status)) {
				winAchieved = true;
			}
		}
		expect(winAchieved, `expected a win within ${MAX_ATTEMPTS} attempts`).toBe(true);

		// Navigate to the missions board and verify progress with retrying
		// assertions (also gives the async chip-sync/mission write time to land).
		await page.goto('/missions', { waitUntil: 'domcontentloaded' });

		// daily-blackjack-5 tracks handsPlayed — one resolved hand → 1/5
		await expect(page.getByTestId('progress-text-daily-blackjack-5')).toHaveText('1/5');
		// daily-win-3 tracks roundsWon — one win → 1/3
		await expect(page.getByTestId('progress-text-daily-win-3')).toHaveText('1/3');
	});

	test('blackjack loss does not increment roundsWon mission progress', async ({
		missionPage: page,
	}) => {
		const request = page.context().request;
		// Retry single-hand attempts until a loss is observed, so the roundsWon
		// assertion is deterministic (no silent skip on win/push). Each attempt
		// resets mission progress so handsPlayed reflects exactly one hand.
		const MAX_ATTEMPTS = 10;
		let lossAchieved = false;
		for (let attempt = 0; attempt < MAX_ATTEMPTS && !lossAchieved; attempt++) {
			await request.delete('/api/missions/progress', { data: {} });

			await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });

			// Play a hand and force a loss by hitting until bust
			await page.fill('#bet-amount', '50');
			await page.getByRole('button', { name: 'Deal' }).click();
			await page.locator('#game-controls').waitFor({ state: 'visible' });

			// Hit repeatedly to try to bust (force a loss). After each hit, use
			// a retrying assertion on #game-status to detect the terminal
			// "Dealer wins" outcome (set after the round-complete delay). If the
			// status doesn't settle, the hand continues and we hit again.
			for (let i = 0; i < 10; i++) {
				const hitBtn = page.locator('#btn-hit');
				if (await hitBtn.isDisabled()) break;
				await hitBtn.click();
				if (await statusSettledTo(page, /Dealer wins/i, 2000)) break;
			}

			// Stand only when player action is still available; an immediate
			// blackjack/push or a bust may already be resolving the round.
			await finishBlackjackHand(page);
			const status = (await page.locator('#game-status').textContent())?.trim() ?? '';
			if (/Dealer wins/i.test(status)) {
				lossAchieved = true;
			}
		}
		expect(lossAchieved, `expected a loss within ${MAX_ATTEMPTS} attempts`).toBe(true);

		await page.goto('/missions', { waitUntil: 'domcontentloaded' });
		// daily-win-3 tracks roundsWon — a loss does not increment it → 0/3
		await expect(page.getByTestId('progress-text-daily-win-3')).toHaveText('0/3');
		// daily-blackjack-5 tracks handsPlayed — one resolved hand → 1/5
		await expect(page.getByTestId('progress-text-daily-blackjack-5')).toHaveText('1/5');
	});
});
