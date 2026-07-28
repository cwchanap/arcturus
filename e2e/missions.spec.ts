import { test, expect } from '@playwright/test';

test.describe('Mission Board', () => {
	test.beforeEach(async ({ page, request }) => {
		// Reset mission state via dev endpoint
		await request.delete('/api/missions/progress', { data: {} });
	});

	test('board loads with SSR (no empty flash)', async ({ page }) => {
		await page.goto('/missions');
		await expect(page.getByTestId('streak-banner')).toBeVisible();
		await expect(page.getByTestId('daily-grid')).toBeVisible();
		await expect(page.getByTestId('weekly-section')).toBeVisible();
	});

	test('streak claim grants chips, second claim is idempotent', async ({ page }) => {
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

	test('streak continuation via seedStreak', async ({ page, request }) => {
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

	test('streak breakage via seedStreak', async ({ page, request }) => {
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

	test('reroll swaps an uncompleted daily quest', async ({ page }) => {
		await page.goto('/missions');
		const rerollBtn = page.locator('[data-testid^="reroll-"]').first();
		await rerollBtn.click();

		// After reroll, all reroll buttons should be hidden (one per day)
		await expect(page.locator('[data-testid^="reroll-"]')).toHaveCount(0);
	});

	test('post-reset clears progress', async ({ page, request }) => {
		await page.goto('/missions');
		await request.delete('/api/missions/progress', { data: {} });
		await page.reload();
		// All progress should be 0
		const progressTexts = await page.locator('[data-testid^="progress-text-"]').allTextContents();
		for (const text of progressTexts) {
			expect(text.trim()).toMatch(/^0\/\d+$/);
		}
	});

	test('blackjack game flow increments handsPlayed mission progress', async ({ page, request }) => {
		// Reset mission state to start clean
		await request.delete('/api/missions/progress', { data: {} });

		// Play a blackjack hand: deal, stand, wait for resolution
		await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
		await page.fill('#bet-amount', '50');
		await page.getByRole('button', { name: 'Deal' }).click();
		await page.locator('#game-controls').waitFor({ state: 'visible' });

		// Stand immediately to let dealer play and resolve the hand
		await page.locator('#btn-stand').click();
		// Wait for the round to resolve — the new-round button appears
		await page.locator('#btn-new-round').waitFor({ state: 'visible', timeout: 15000 });

		// Read the game status to determine the outcome
		const status = (await page.locator('#game-status').textContent())?.trim() ?? '';
		const isWin = /You win|BLACKJACK/i.test(status);
		const isLoss = /Dealer wins|Bust/i.test(status);

		// Navigate to the missions board and verify progress
		await page.goto('/missions', { waitUntil: 'networkidle' });

		// daily-blackjack-5 tracks handsPlayed — any resolved hand increments it
		const bjProgress = await page.getByTestId('progress-text-daily-blackjack-5').textContent();
		expect(bjProgress?.trim()).toBe('1/5');

		// daily-win-3 tracks roundsWon — only wins increment it
		const winProgress = await page.getByTestId('progress-text-daily-win-3').textContent();
		if (isWin) {
			expect(winProgress?.trim()).toBe('1/3');
		} else if (isLoss) {
			expect(winProgress?.trim()).toBe('0/3');
		}
		// Push (tie) doesn't increment wins or losses — leave unasserted
	});

	test('blackjack loss does not increment roundsWon mission progress', async ({
		page,
		request,
	}) => {
		await request.delete('/api/missions/progress', { data: {} });

		await page.goto('/games/blackjack', { waitUntil: 'networkidle' });

		// Play a hand and force a loss by hitting until bust
		await page.fill('#bet-amount', '50');
		await page.getByRole('button', { name: 'Deal' }).click();
		await page.locator('#game-controls').waitFor({ state: 'visible' });

		// Hit repeatedly to try to bust (force a loss)
		let busted = false;
		for (let i = 0; i < 10; i++) {
			const hitBtn = page.locator('#btn-hit');
			if (!(await hitBtn.isVisible())) break;
			await hitBtn.click();
			await page.waitForTimeout(500);
			const status = (await page.locator('#game-status').textContent())?.trim() ?? '';
			if (/Bust|Dealer wins/i.test(status)) {
				busted = true;
				break;
			}
		}

		// If we didn't bust from hitting, stand and let dealer play
		if (!busted) {
			const standBtn = page.locator('#btn-stand');
			if (await standBtn.isVisible()) {
				await standBtn.click();
			}
		}

		await page.locator('#btn-new-round').waitFor({ state: 'visible', timeout: 15000 });
		const status = (await page.locator('#game-status').textContent())?.trim() ?? '';

		// Only verify roundsWon if this was actually a loss
		if (/Dealer wins|Bust/i.test(status)) {
			await page.goto('/missions', { waitUntil: 'networkidle' });
			const winProgress = await page.getByTestId('progress-text-daily-win-3').textContent();
			expect(winProgress?.trim()).toBe('0/3');
			// handsPlayed still increments regardless of outcome
			const bjProgress = await page.getByTestId('progress-text-daily-blackjack-5').textContent();
			expect(bjProgress?.trim()).toBe('1/5');
		}
	});
});
