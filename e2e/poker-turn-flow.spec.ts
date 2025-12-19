import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

test.describe('Poker turn flow smoke test', () => {
	test('deal, human action, AI acts, next phase continues', async ({ page }) => {
		// Ensure authentication and navigate to poker game
		await ensureLoggedIn(page);
		await page.goto('/games/poker', { waitUntil: 'networkidle' });

		const dealButton = page.getByRole('button', { name: 'DEAL NEW HAND' });
		await dealButton.click();

		await expect(page.locator('#player-cards .playing-card')).toHaveCount(2, { timeout: 5000 });

		const status = page.locator('#game-status');
		await expect(status).toContainText('Your turn', { timeout: 5000 });

		const checkButton = page.getByRole('button', { name: /check/i });
		const callButton = page.getByRole('button', { name: /call/i });
		if (await checkButton.isEnabled()) {
			await checkButton.click();
		} else if (await callButton.isEnabled()) {
			await callButton.click();
		} else {
			throw new Error('No legal action button was enabled (expected Check or Call)');
		}

		await expect(status).toHaveText(/You checked|You called|Waiting for/i, { timeout: 5000 });
		await expect(status).toBeVisible();

		await expect(status).toHaveText(/\[(Flop|Turn|River|Showdown).*|wins \$/i, {
			timeout: 10000,
		});
	});
});
