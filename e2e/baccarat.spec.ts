import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

async function gotoBaccarat(page: Page) {
	await ensureLoggedIn(page);
	await page.goto('/games/baccarat', { waitUntil: 'networkidle' });
}

// Phase 3: Basic Baccarat Round (US1)
test.describe('Baccarat Game - Basic Round Flow', () => {
	test('should load baccarat page with correct initial state', async ({ page }) => {
		await gotoBaccarat(page);

		// Check page title
		await expect(page.locator('h1')).toContainText('Baccarat');

		// Check balance is displayed
		await expect(page.locator('#chip-balance')).toBeVisible();

		// Check betting areas are present
		await expect(page.locator('[data-bet-type="player"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="banker"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="tie"]')).toBeVisible();

		// Check deal button exists and is disabled (no bets)
		const dealButton = page.locator('#deal-button');
		await expect(dealButton).toBeVisible();
		await expect(dealButton).toBeDisabled();
	});

	test('should place a bet and enable deal button', async ({ page }) => {
		await gotoBaccarat(page);

		// Explicitly select the lowest-value chip to avoid relying on defaults
		const lowestChip = page.locator('.chip-select[data-amount="10"]');
		await lowestChip.click();
		await expect(lowestChip).toHaveClass(/selected/);

		// Click on player bet area
		const playerBetArea = page.locator('[data-bet-type="player"]');
		await playerBetArea.click();

		// Check bet is placed with the selected chip amount
		await expect(page.locator('#total-bet')).toContainText('$10');

		// Check deal button is enabled
		const dealButton = page.locator('#deal-button');
		await expect(dealButton).toBeEnabled();
	});

	test('should complete a full round with player bet', async ({ page }) => {
		await gotoBaccarat(page);

		// Get initial balance
		const balanceText = await page.locator('#chip-balance').textContent();
		const initialBalance = parseInt(balanceText?.replace(/[$,]/g, '') || '1000');

		// Select $50 chip
		await page.click('.chip-select[data-amount="50"]');

		// Place bet on player
		await page.click('[data-bet-type="player"]');

		// Click deal
		await page.click('#deal-button');

		// Wait for round result to appear
		await expect(page.locator('#round-result')).toBeVisible({ timeout: 15000 });

		// Check result shows winner
		const resultText = await page.locator('.result-winner').textContent();
		expect(resultText).toMatch(/Player Wins!|Banker Wins!|Tie!/);

		// Check scores are displayed
		await expect(page.locator('.result-scores')).toContainText('Player:');
		await expect(page.locator('.result-scores')).toContainText('Banker:');

		// Balance should have changed
		const newBalanceText = await page.locator('#chip-balance').textContent();
		const newBalance = parseInt(newBalanceText?.replace(/[$,]/g, '') || '0');
		expect(newBalance).not.toBe(initialBalance);
	});

	test('should allow placing multiple bet types', async ({ page }) => {
		await gotoBaccarat(page);

		// Select $50 chip so each click adds $50; total expected = $100
		await page.click('.chip-select[data-amount="50"]');

		// Place bets on player and tie
		await page.click('[data-bet-type="player"]');
		await page.click('[data-bet-type="tie"]');

		// Check both bet areas are highlighted
		await expect(page.locator('[data-bet-type="player"]')).toHaveClass(/bet-area-active/);
		await expect(page.locator('[data-bet-type="tie"]')).toHaveClass(/bet-area-active/);

		// Total bet should be $100 (50 + 50)
		await expect(page.locator('#total-bet')).toContainText('$100');
	});

	test('should clear bets when clear button is clicked', async ({ page }) => {
		await gotoBaccarat(page);

		// Place a bet (select chip first to avoid flakiness)
		await page.click('.chip-select[data-amount="10"]');
		await page.click('[data-bet-type="player"]');
		await expect(page.locator('#total-bet')).not.toContainText('$0');

		// Click clear button
		await page.click('#clear-bets-button');

		// Check bets are cleared
		await expect(page.locator('#total-bet')).toContainText('$0');
		await expect(page.locator('#deal-button')).toBeDisabled();
	});

	test('should start new round after result', async ({ page }) => {
		await gotoBaccarat(page);

		// Play a round
		const chip = page.locator('.chip-select[data-amount="10"]');
		await chip.click();
		await expect(chip).toHaveClass(/selected/);

		await page.click('[data-bet-type="banker"]');
		await page.click('#deal-button');
		await expect(page.locator('#round-result')).toBeVisible({ timeout: 15000 });

		// Click new round button
		await page.click('#new-round-button');

		// Check result is hidden
		await expect(page.locator('#round-result')).toBeHidden();

		// Check we can place new bets
		await expect(page.locator('#deal-button')).toBeDisabled();

		await chip.click();
		await expect(chip).toHaveClass(/selected/);

		await page.click('[data-bet-type="player"]');
		await expect(page.locator('#deal-button')).toBeEnabled();
	});

	test('should update scoreboard after round', async ({ page }) => {
		await gotoBaccarat(page);

		// Play a round
		await page.click('.chip-select[data-amount="10"]');
		await page.click('[data-bet-type="player"]');
		await page.click('#deal-button');
		await expect(page.locator('#round-result')).toBeVisible({ timeout: 15000 });

		// Check scoreboard has an entry
		await expect(page.locator('#scoreboard .scoreboard-dot')).toHaveCount(1);
	});
});

// Phase 4: Side Bets (US2)
test.describe('Baccarat Game - Side Bets', () => {
	test('should place player pair bet', async ({ page }) => {
		await gotoBaccarat(page);

		// Select chip and place main bet before side bet
		const chip = page.locator('.chip-select[data-amount="10"]');
		await chip.click();
		await expect(chip).toHaveClass(/selected/);

		const playerBet = page.locator('[data-bet-type="player"]');
		await playerBet.click();
		await expect(playerBet).toHaveClass(/bet-area-active/);

		// Place side bet
		const playerPairBet = page.locator('[data-bet-type="playerPair"]');
		await playerPairBet.click();

		// Check side bet is active (main bet remains active)
		await expect(playerPairBet).toHaveClass(/bet-area-active/);
		await expect(playerBet).toHaveClass(/bet-area-active/);
	});

	test('should place banker pair bet', async ({ page }) => {
		await gotoBaccarat(page);

		// Select chip and place required main bet
		const chip = page.locator('.chip-select[data-amount="10"]');
		await chip.click();
		await expect(chip).toHaveClass(/selected/);

		const bankerBet = page.locator('[data-bet-type="banker"]');
		await bankerBet.click();
		await expect(bankerBet).toHaveClass(/bet-area-active/);

		// Place side bet
		const bankerPairBet = page.locator('[data-bet-type="bankerPair"]');
		await bankerPairBet.click();

		// Check both bets are active
		await expect(bankerPairBet).toHaveClass(/bet-area-active/);
		await expect(bankerBet).toHaveClass(/bet-area-active/);
	});

	test('should complete round with side bet', async ({ page }) => {
		await gotoBaccarat(page);

		// Select $50 chip for deterministic bet amounts
		await page.click('.chip-select[data-amount="50"]');

		// Place main bet and side bet
		await page.click('[data-bet-type="player"]');
		await page.click('[data-bet-type="playerPair"]');

		// Deal
		await page.click('#deal-button');
		await expect(page.locator('#round-result')).toBeVisible({ timeout: 15000 });

		// Check results show both bet outcomes
		await expect(page.locator('.result-bets')).toContainText('Player');
		await expect(page.locator('.result-bets')).toContainText('P. Pair');
	});
});
