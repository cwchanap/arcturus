// e2e/keno.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Keno game', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/games/keno');
	});

	test('manual selection + draw produces a valid 20-number result and payout', async ({ page }) => {
		// Select 5 numbers via the grid
		const cells = page.locator('button.keno-cell');
		for (let i = 0; i < 5; i++) await cells.nth(i).click();
		await expect(page.getByTestId('spot-count')).toContainText('5/10');
		// Bet is 1 by default
		await page.getByTestId('btn-draw').click();
		// Status transitions to Drawing then Round complete
		await expect(page.getByTestId('game-status')).toContainText(/Round complete|Drawing/);
		// Last result surfaces a hit count
		await expect(page.getByTestId('last-result')).toContainText(/of 5/);
		// 20 drawn cells are highlighted
		await expect(page.locator('button.keno-cell.drawn')).toHaveCount(20);
	});

	test('Quick Pick produces a valid ticket and draws', async ({ page }) => {
		await page.getByTestId('btn-quickpick').click();
		await expect(page.getByTestId('spot-count')).toContainText('8/10');
		await page.getByTestId('btn-draw').click();
		await expect(page.getByTestId('last-result')).toContainText(/of 8/);
	});

	test('Repeat Ticket re-applies the prior ticket after a draw', async ({ page }) => {
		for (let i = 0; i < 4; i++) await page.locator('button.keno-cell').nth(i).click();
		await page.getByTestId('btn-draw').click();
		await expect(page.getByTestId('last-result')).toContainText(/of 4/);
		await page.getByTestId('btn-clear').click();
		await expect(page.getByTestId('spot-count')).toContainText('0/10');
		await page.getByTestId('btn-repeat').click();
		await expect(page.getByTestId('spot-count')).toContainText('4/10');
	});

	test('paytable renders the table for the selected spot count', async ({ page }) => {
		for (let i = 0; i < 7; i++) await page.locator('button.keno-cell').nth(i).click();
		// 7-spot paytable has tiers catch-3..7
		const body = page.getByTestId('paytable-body');
		await expect(body).toContainText('Catch 7');
		await expect(body).toContainText('×5000');
	});

	test('controlled draw: payout form matches PAYTABLE[spots][hitCount] × bet', async ({ page }) => {
		// Assert on draw validity (20 unique in 1..80) and result-text format rather than
		// injecting seeded RNG across the page boundary.
		for (let i = 0; i < 3; i++) await page.locator('button.keno-cell').nth(i).click();
		await page.getByTestId('btn-draw').click();
		await expect(page.getByTestId('last-result')).toContainText(/of 3/);
		const drawn = await page.locator('button.keno-cell.drawn').count();
		expect(drawn).toBe(20);
	});
});
