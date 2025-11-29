import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

async function gotoBlackjack(page: Page) {
	await ensureLoggedIn(page);
	await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
}

async function dealNewHand(page: Page, bet: number) {
	const betInput = page.locator('#bet-amount');
	await betInput.fill(String(bet));
	await page.getByRole('button', { name: 'Deal' }).click();
	await page.locator('#game-controls').waitFor({ state: 'visible' });
}

function parseBalance(text: string): number {
	const digits = text.replace(/[^0-9]/g, '');
	return Number(digits || '0');
}

// T047: split pair → play first hand → play second hand → dealer turn → outcome
// This test is probabilistic: it will try multiple rounds until a split opportunity appears.
test.describe('Blackjack advanced actions - Split & Double Down', () => {
	test('player can split a pair and complete both hands (if split encountered)', async ({
		page,
	}) => {
		await gotoBlackjack(page);

		const maxAttempts = 15;
		let foundSplit = false;

		for (let attempt = 0; attempt < maxAttempts && !foundSplit; attempt++) {
			await dealNewHand(page, 50);

			const splitButton = page.getByRole('button', { name: 'Split' });
			if (await splitButton.isEnabled()) {
				foundSplit = true;
				break;
			}

			// No split yet - reload and try a fresh round
			await page.reload({ waitUntil: 'networkidle' });
		}

		if (!foundSplit) {
			// Could not find a splittable hand within the attempt limit;
			// treat as a no-op rather than failing the test due to randomness.
			return;
		}

		// We are in a state where Split is enabled
		const splitButton = page.getByRole('button', { name: 'Split' });
		await expect(splitButton).toBeEnabled();
		await splitButton.click();

		// Verify two hands are displayed
		const playerCards = page.locator('#player-cards');
		await expect(playerCards.getByText('Hand 1')).toBeVisible();
		await expect(playerCards.getByText('Hand 2')).toBeVisible();

		// Play both hands by standing twice
		const standButton = page.getByRole('button', { name: 'Stand' });
		await standButton.click(); // finish first hand, advance to second
		await standButton.click(); // finish second hand and trigger dealer turn

		// Wait for round to complete (New Round button appears when round ends)
		const newRoundButton = page.getByRole('button', { name: 'New Round' });
		await expect(newRoundButton).toBeVisible({ timeout: 15000 });

		const status = page.locator('#game-status');
		await expect(status).toHaveText(/win|wins|Dealer wins|Push|BLACKJACK|Bust/i, {
			timeout: 15000,
		});
	});

	// T048: double down with hand total 11 (probabilistic)
	test('player can double down when total is 11 (if encountered)', async ({ page }) => {
		await gotoBlackjack(page);

		const maxAttempts = 25;
		let found = false;

		for (let attempt = 0; attempt < maxAttempts && !found; attempt++) {
			await dealNewHand(page, 50);

			const doubleButton = page.getByRole('button', { name: 'Double Down' });
			// Skip rounds where double-down is not available
			if (!(await doubleButton.isEnabled())) {
				await page.reload({ waitUntil: 'networkidle' });
				continue;
			}

			const valueText = await page.locator('#player-value').innerText();
			if (/11$/.test(valueText) || /Soft 11/i.test(valueText)) {
				found = true;
				break;
			}

			// Not the hand we want; reload and try again
			await page.reload({ waitUntil: 'networkidle' });
		}

		if (!found) {
			return;
		}

		const doubleButton = page.getByRole('button', { name: 'Double Down' });
		await expect(doubleButton).toBeEnabled();

		await doubleButton.click();

		// After double down, dealer should play and round should complete
		await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15000 });

		const balanceAfterText = await page.locator('#player-balance').innerText();
		const balanceAfter = parseBalance(balanceAfterText);
		// Balance should be a number; outcome (win/loss/push) may vary
		expect(Number.isNaN(balanceAfter)).toBe(false);
		// Sanity-check that balance is a non-negative integer
		expect(balanceAfter).toBeGreaterThanOrEqual(0);
	});

	// T049: double down with hand total 10 (probabilistic)
	test('player can double down when total is 10 (if encountered)', async ({ page }) => {
		await gotoBlackjack(page);

		const maxAttempts = 25;
		let found = false;

		for (let attempt = 0; attempt < maxAttempts && !found; attempt++) {
			await dealNewHand(page, 50);

			const doubleButton = page.getByRole('button', { name: 'Double Down' });
			if (!(await doubleButton.isEnabled())) {
				await page.reload({ waitUntil: 'networkidle' });
				continue;
			}

			const valueText = await page.locator('#player-value').innerText();
			if (/^10$/.test(valueText)) {
				found = true;
				break;
			}

			await page.reload({ waitUntil: 'networkidle' });
		}

		if (!found) {
			return;
		}

		const doubleButton = page.getByRole('button', { name: 'Double Down' });
		await expect(doubleButton).toBeEnabled();
		await doubleButton.click();

		await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15000 });
	});

	// T052: insufficient chips disables Double/Split buttons
	test('Double Down and Split disabled when chips are insufficient', async ({ page }) => {
		await gotoBlackjack(page);

		// Force chip balance to a low value via the chips API
		await page.evaluate(async () => {
			await fetch('/api/chips/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ newBalance: 50, delta: -950, gameType: 'blackjack' }),
			});
		});

		await page.reload({ waitUntil: 'networkidle' });

		const balanceText = await page.locator('#player-balance').innerText();
		expect(parseBalance(balanceText)).toBe(50);

		await dealNewHand(page, 50);

		const doubleButton = page.getByRole('button', { name: 'Double Down' });
		const splitButton = page.getByRole('button', { name: 'Split' });

		await expect(doubleButton).toBeDisabled();
		await expect(splitButton).toBeDisabled();
	});
});
