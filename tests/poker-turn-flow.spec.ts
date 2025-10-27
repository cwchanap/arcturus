import { test, expect } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4321';

async function ensureGamePage(page) {
	await page.goto(`${BASE_URL}/games/poker`, { waitUntil: 'networkidle' });
	if (
		await page
			.locator('text=Sign in to continue')
			.first()
			.isVisible({ timeout: 1000 })
			.catch(() => false)
	) {
		throw new Error(
			'Poker page requires authentication. Set PLAYWRIGHT_BASE_URL to a running instance where you are already signed in.',
		);
	}
}

async function waitForText(page, locator, text) {
	await expect(locator).toHaveText(text, { timeout: 10_000 });
}

test.describe('Poker turn flow smoke test', () => {
	test('deal, human check, AI acts, next phase continues', async ({ page }) => {
		await ensureGamePage(page);

		const dealButton = page.getByRole('button', { name: 'DEAL NEW HAND' });
		await dealButton.click();

		await expect(page.locator('#player-cards .playing-card')).toHaveCount(2, { timeout: 5000 });
		await expect(page.locator('#community-cards .playing-card')).not.toHaveCount(0, {
			timeout: 5000,
		});

		const status = page.locator('#game-status');
		await expect(status).toContainText('Your turn', { timeout: 5000 });

		await page.getByRole('button', { name: 'CHECK' }).click();

		await expect(status).toContainText(/Waiting for Player \d/, { timeout: 5000 });

		await expect(status).toContainText('Waiting for', { timeout: 5000 });
		await expect(status).not.toContainText('Your turn', { timeout: 5000 });

		await expect(status).toContainText('Your turn', { timeout: 5000 });
	});
});
