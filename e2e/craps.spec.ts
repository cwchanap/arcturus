import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

async function gotoCraps(page: Page) {
	await ensureLoggedIn(page);
	await page.goto('/games/craps', { waitUntil: 'networkidle' });
}

test.describe('Craps — Initial State', () => {
	test('loads page with correct initial state', async ({ page }) => {
		await gotoCraps(page);

		await expect(page.getByRole('heading', { name: 'Craps', exact: true })).toBeVisible();
		await expect(page.locator('#chip-balance')).toBeVisible();
		await expect(page.locator('#phase-badge')).toContainText('Come-Out');
		await expect(page.locator('#roll-button')).toBeDisabled();
		await expect(page.locator('[data-bet-type="passLine"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="dontPass"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="field"]')).toBeVisible();
	});

	test('odds row is hidden during come-out', async ({ page }) => {
		await gotoCraps(page);
		await expect(page.locator('#odds-row')).toBeHidden();
	});
});

test.describe('Craps — Bet Placement', () => {
	test('places a Pass Line bet and enables Roll button', async ({ page }) => {
		await gotoCraps(page);

		// Select $25 chip
		await page.click('.chip-select[data-amount="25"]');
		await page.click('[data-bet-type="passLine"]');

		await expect(page.locator('#total-bet')).toContainText('$25');
		await expect(page.locator('#roll-button')).toBeEnabled();
	});

	test('places multiple bet types', async ({ page }) => {
		await gotoCraps(page);

		await page.click('.chip-select[data-amount="5"]');
		await page.click('[data-bet-type="passLine"]');
		await page.click('[data-bet-type="field"]');

		await expect(page.locator('#total-bet')).toContainText('$10');
	});

	test('Clear Bets removes all bets and resets total', async ({ page }) => {
		await gotoCraps(page);

		await page.click('.chip-select[data-amount="25"]');
		await page.click('[data-bet-type="passLine"]');
		await page.click('#clear-bets-button');

		await expect(page.locator('#total-bet')).toContainText('$0');
		await expect(page.locator('#roll-button')).toBeDisabled();
	});
});

test.describe('Craps — Game Flow', () => {
	test('rolling dice shows total and updates message', async ({ page }) => {
		await gotoCraps(page);

		await page.click('.chip-select[data-amount="25"]');
		await page.click('[data-bet-type="passLine"]');
		await page.click('#roll-button');

		// Wait for roll to complete (animation ~420ms + processing)
		await page.waitForTimeout(800);

		// Roll total should be a number 2–12
		const totalText = await page.locator('#roll-total').textContent();
		const total = parseInt(totalText ?? '0');
		expect(total).toBeGreaterThanOrEqual(2);
		expect(total).toBeLessThanOrEqual(12);

		// Message should be non-empty
		const msg = await page.locator('#game-message').textContent();
		expect(msg).toBeTruthy();
		expect(msg!.length).toBeGreaterThan(0);
	});

	test('rolling a point establishes point phase', async ({ page }) => {
		await gotoCraps(page);

		// Keep rolling until a point is established
		await page.click('.chip-select[data-amount="5"]');
		await page.click('[data-bet-type="passLine"]');

		let pointEstablished = false;
		for (let attempt = 0; attempt < 15; attempt++) {
			await page.click('#roll-button');
			await page.waitForTimeout(700);

			const phase = await page.locator('#phase-badge').textContent();
			if (phase?.includes('Point')) {
				pointEstablished = true;
				break;
			}
			// If natural or craps, place a new pass line bet and try again
			const rollBtn = await page.locator('#roll-button');
			const disabled = await rollBtn.isDisabled();
			if (disabled) {
				await page.click('[data-bet-type="passLine"]');
			}
		}

		expect(pointEstablished).toBe(true);
		await expect(page.locator('#point-badge')).toBeVisible();
		await expect(page.locator('#odds-row')).toBeVisible();
	});

	test('roll history is populated after rolls', async ({ page }) => {
		await gotoCraps(page);

		await page.click('.chip-select[data-amount="5"]');
		await page.click('[data-bet-type="passLine"]');
		await page.click('[data-bet-type="field"]');
		await page.click('#roll-button');
		await page.waitForTimeout(700);

		const badges = page.locator('#roll-history .roll-badge');
		await expect(badges).toHaveCount(1);
	});
});

test.describe('Craps — Active Bets Panel', () => {
	test('active bets shows placed bet', async ({ page }) => {
		await gotoCraps(page);

		await page.click('.chip-select[data-amount="50"]');
		await page.click('[data-bet-type="passLine"]');

		await expect(page.locator('#active-bets')).toContainText('Pass Line');
		await expect(page.locator('#active-bets')).toContainText('$50');
	});

	test('balance decreases when bet is placed', async ({ page }) => {
		await gotoCraps(page);

		const balanceBefore = parseInt(
			(await page.locator('#chip-balance').textContent())?.replace(/[$,]/g, '') ?? '0',
		);

		await page.click('.chip-select[data-amount="100"]');
		await page.click('[data-bet-type="passLine"]');

		const balanceAfter = parseInt(
			(await page.locator('#chip-balance').textContent())?.replace(/[$,]/g, '') ?? '0',
		);

		expect(balanceAfter).toBe(balanceBefore - 100);
	});
});
