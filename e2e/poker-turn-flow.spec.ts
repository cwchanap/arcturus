import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { bootstrapTestUser } from './bootstrap-auth';

async function createIsolatedPokerPage(browser: Browser, baseURL?: string) {
	const context = await browser.newContext({ baseURL: baseURL ?? 'http://localhost:2000' });
	const page = await context.newPage();
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await bootstrapTestUser(context, baseURL ?? 'http://localhost:2000', {
		email: `poker-sync-${nonce}@arcturus.local`,
		name: `Poker Sync ${nonce}`,
	});
	await page.goto(baseURL ?? 'http://localhost:2000', { waitUntil: 'domcontentloaded' });
	await page.goto('/games/poker', { waitUntil: 'networkidle' });
	return { context, page };
}

test.describe('Poker turn flow smoke test', () => {
	test('deal, human action, AI acts, next phase continues', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedPokerPage(browser, baseURL);
		try {
			await page.getByRole('button', { name: /configure/i }).click();
			await expect(page.locator('#setting-ai-difficulty-1')).toBeVisible();
			await expect(page.locator('#setting-ai-difficulty-2')).toBeVisible();
			await expect(page.locator('#setting-ai-difficulty-1')).toHaveValue('medium');
			await expect(page.locator('#setting-ai-difficulty-2')).toHaveValue('medium');
			await page.getByRole('button', { name: /configure/i }).click();

			const dealButton = page.getByRole('button', { name: 'DEAL NEW HAND' });
			await dealButton.click();

			// With slot-based rendering, check for visible card faces (not hidden)
			await expect(page.locator('#player-cards .card-slot[data-slot-state="card"]')).toHaveCount(
				2,
				{
					timeout: 5000,
				},
			);

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
		} finally {
			await context.close();
		}
	});
});
