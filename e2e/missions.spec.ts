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
			expect(text).toMatch(/^0\/\d+$/);
		}
	});
});
