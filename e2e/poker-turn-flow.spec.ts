import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

const createIsolatedPokerPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'poker-sync',
		namePrefix: 'Poker Sync',
		navigate: async (page: Page) => {
			await page.goto('/games/poker', { waitUntil: 'networkidle' });
		},
	});

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
			const checkButton = page.getByRole('button', { name: /check/i });
			const callButton = page.getByRole('button', { name: /call/i });
			const nextPhaseOrTerminal =
				/Flop revealed!|Turn card revealed!|River card revealed!|Showdown|wins .* chips|Tie!.*split the .* chips pot/i;
			const playerTurnOrProgress =
				/Your turn|Flop revealed!|Turn card revealed!|River card revealed!|Showdown|wins .* chips|Tie!.*split the .* chips pot/i;

			for (let humanActions = 0; humanActions < 8; humanActions++) {
				await expect(status).toHaveText(playerTurnOrProgress, { timeout: 10000 });
				const currentStatus = (await status.textContent())?.trim() ?? '';
				if (nextPhaseOrTerminal.test(currentStatus)) break;

				if (await checkButton.isEnabled()) {
					await checkButton.click();
				} else if (await callButton.isEnabled()) {
					await callButton.click();
				} else {
					throw new Error('No legal action button was enabled (expected Check or Call)');
				}

				await expect(status).not.toHaveText(currentStatus, { timeout: 5000 });
			}

			await expect(status).toHaveText(nextPhaseOrTerminal, { timeout: 10000 });
		} finally {
			await context.close();
		}
	});
});
