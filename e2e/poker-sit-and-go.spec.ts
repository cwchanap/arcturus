import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

// Sit & Go is a smoke surface only: final placement and blind-level math are
// covered deterministically by unit tests (sitAndGo.test.ts, PokerGame.test.ts),
// so this spec checks page load, tournament labels, and the terminal links.

const createIsolatedSngPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'poker-sng',
		namePrefix: 'Poker SNG',
		navigate: async (page: Page) => {
			await page.goto('/games/poker?mode=sng', { waitUntil: 'networkidle' });
		},
	});

test.describe('Poker Sit & Go smoke', () => {
	test('loads six 500-chip stacks with tournament labels and no cash chrome', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedSngPage(browser, baseURL);
		try {
			await expect(page.locator('#poker-root')).toHaveAttribute('data-poker-mode', 'sng');

			// Six seats, 500 tournament chips each; the bankroll label says
			// tournament chips, not a cash or guest balance.
			await expect(page.getByText('Tournament chips')).toBeVisible();
			await expect(page.locator('#player-balance')).toHaveText('500 chips');
			for (const id of [1, 2, 3, 4, 5]) {
				await expect(page.locator(`#opponent${id}-chips`)).toHaveText('500');
			}

			// Tournament header: six funded players, no finish place yet.
			await expect(page.getByTestId('poker-tournament')).toBeVisible();
			await expect(page.locator('#tournament-players')).toHaveText('6');
			await expect(page.locator('#tournament-place-row')).toBeHidden();

			// Cash-only chrome stays off the tournament page.
			await expect(page.locator('#poker-session')).toHaveCount(0);
			await expect(page.locator('#poker-missions')).toHaveCount(0);
			await expect(page.locator('#btn-rebuy')).toHaveCount(0);
			for (const id of [
				'setting-starting-chips',
				'setting-small-blind',
				'setting-big-blind',
				'setting-use-llm-ai',
			]) {
				await expect(page.locator(`#${id}`)).toBeHidden();
			}

			// Dealing the first hand lights up the header: hand 1, level 1 of 5,
			// and the next blind change after this five-hand level.
			await page.locator('#btn-deal').click();
			await expect(page.locator('#tournament-hands')).toHaveText('1');
			await expect(page.locator('#tournament-level')).toHaveText('1 / 5');
			await expect(page.locator('#tournament-next')).toHaveText('10 / 20 · 5 to go');
			await expect(page.locator('#table-blinds')).toHaveText('5 / 10');
		} finally {
			await context.close();
		}
	});

	test('terminal links reload a fresh tournament and return to cash', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedSngPage(browser, baseURL);
		try {
			// The panel only appears at tournament end, and randomized full
			// tournaments are deliberately out of E2E scope; reveal it to smoke
			// the plain links. Both anchors trigger full page loads, which IS
			// the reset.
			const revealPanel = () =>
				page.evaluate(() => {
					const panel = document.getElementById('poker-terminal');
					if (!panel) throw new Error('terminal panel missing');
					panel.hidden = false;
				});
			await revealPanel();
			await expect(page.getByTestId('poker-terminal')).toBeVisible();

			await page.locator('#poker-terminal').getByRole('link', { name: 'New Tournament' }).click();
			await expect(page.locator('#poker-root')).toHaveAttribute('data-poker-mode', 'sng');
			await expect(page.locator('#player-balance')).toHaveText('500 chips');
			await expect(page.locator('#tournament-players')).toHaveText('6');
			await expect(page.getByTestId('poker-terminal')).toBeHidden();

			await revealPanel();
			await page.locator('#poker-terminal').getByRole('link', { name: 'Cash Poker' }).click();
			await expect(page.locator('#poker-root')).toHaveAttribute('data-poker-mode', 'cash');
			// Cash keeps its session tally and, for a signed-in player, the
			// missions ring the tournament page hides.
			await expect(page.locator('#poker-session')).toBeVisible();
			await expect(page.locator('#poker-missions')).toBeVisible();
		} finally {
			await context.close();
		}
	});
});
