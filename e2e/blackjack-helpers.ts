import type { Page } from '@playwright/test';

/**
 * Deal a hand and wait until the player's turn is reachable.
 *
 * Retries up to 5 times: if the deal lands on a finished (New Round) state
 * (e.g. dealer blackjack), reload and try again. Throws when the player turn
 * still cannot be reached after the retries are exhausted.
 */
export async function dealHand(page: Page, bet: number = 50): Promise<void> {
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
