import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TEST_USER } from './auth.setup';

async function ensureLoggedIn(page: Page) {
	await page.goto('/signin');
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');

	await page.waitForTimeout(1500);
	if (page.url().endsWith('/')) {
		return;
	}

	await page.goto('/signup');
	await page.fill('input[name="name"]', TEST_USER.name);
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');
	await page.waitForURL('/', { timeout: 15000 });
}

test.describe('Poker turn flow smoke test', () => {
	test('deal, human check, AI acts, next phase continues', async ({ page }) => {
		// Ensure authentication and navigate to poker game
		await ensureLoggedIn(page);
		await page.goto('/games/poker', { waitUntil: 'networkidle' });

		const dealButton = page.getByRole('button', { name: 'DEAL NEW HAND' });
		await dealButton.click();

		await expect(page.locator('#player-cards .playing-card')).toHaveCount(2, { timeout: 5000 });
		await expect(page.locator('#community-cards > div')).toHaveCount(5);

		const status = page.locator('#game-status');
		await expect(status).toContainText('Your turn', { timeout: 5000 });
		const initialText = await status.innerText();

		await page.getByRole('button', { name: 'CHECK' }).click();

		// Wait for status text to change, indicating AI action / hand progression
		await expect(status).not.toHaveText(initialText, { timeout: 5000 });
		await expect(status).toBeVisible();
	});
});
