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
		// A 6-max hand runs several AI orbits per street; allow time for a full hand.
		test.setTimeout(60000);
		const { context, page } = await createIsolatedPokerPage(browser, baseURL);
		try {
			await page.getByRole('button', { name: /configure/i }).click();
			await expect(page.locator('#setting-ai-difficulty-1')).toBeVisible();
			await expect(page.locator('#setting-ai-difficulty-2')).toBeVisible();
			await expect(page.locator('#setting-ai-difficulty-1')).toHaveValue('medium');
			await expect(page.locator('#setting-ai-difficulty-2')).toHaveValue('medium');
			// Fast AI (300-600ms/action) keeps a full 6-max hand inside the test
			// budget; saving applies the speed and closes the drawer.
			await page.locator('#setting-ai-speed').selectOption('fast');
			await page
				.getByRole('dialog', { name: 'Game Settings' })
				.getByRole('button', { name: 'Save Settings' })
				.click();

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
			// Action buttons hide/show per betting state, so getByRole (which skips
			// hidden elements) can leave these locators unresolved — probe by id
			// and let `disabled` report legality.
			const checkButton = page.locator('#btn-check');
			const callButton = page.locator('#btn-call');
			const nextPhaseOrTerminal =
				/Flop revealed!|Turn card revealed!|River card revealed!|Showdown|wins? .* chips|Tie!.*split the .* chips pot/i;
			const playerTurnOrProgress =
				/Your turn|Flop revealed!|Turn card revealed!|River card revealed!|Showdown|wins? .* chips|Tie!.*split the .* chips pot/i;

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

	test('manual fold in the recap carries exactly one grade stamp', async ({ browser, baseURL }) => {
		// Human folds preflop, then five AIs finish the hand; keep it in budget.
		test.setTimeout(60000);
		const { context, page } = await createIsolatedPokerPage(browser, baseURL);
		try {
			// A timer-forced fold is never graded; disable the turn timer so the
			// fold below stays manual without racing the 20-second clock.
			const timerToggle = page.locator('#btn-turn-timer');
			await expect(timerToggle).toHaveAttribute('aria-pressed', 'true');
			await timerToggle.click();
			await expect(timerToggle).toHaveAttribute('aria-pressed', 'false');

			// Same speed setup as the turn-flow smoke: keeps AI orbits quick.
			await page.getByRole('button', { name: /configure/i }).click();
			await page.locator('#setting-ai-speed').selectOption('fast');
			await page
				.getByRole('dialog', { name: 'Game Settings' })
				.getByRole('button', { name: 'Save Settings' })
				.click();

			const status = page.locator('#game-status');
			const handEndedOrYourTurn = /Your turn|wins? .* chips|Tie!.*split the .* chips pot|Showdown/i;
			const dealButton = page.locator('#btn-deal');

			// Rare: five AIs can fold around an on-the-button human before they
			// act, ending the hand with no manual decision — re-deal instead.
			let foldedManually = false;
			for (let attempt = 0; attempt < 3 && !foldedManually; attempt++) {
				await dealButton.click();
				await expect(status).toHaveText(handEndedOrYourTurn, { timeout: 10000 });
				if (/Your turn/i.test((await status.textContent()) ?? '')) {
					foldedManually = true;
					await page.locator('#btn-fold').click();
				}
			}
			expect(foldedManually, 'human never got a turn across three deals').toBe(true);

			// The recap button appears only once the hand is settled.
			const recapButton = page.locator('#btn-recap');
			await expect(recapButton).toBeVisible({ timeout: 45000 });
			await recapButton.click();
			const recapPanel = page.locator('#recap-panel');
			await expect(recapPanel).toBeVisible();

			// The deck is not seeded, so the grade tier is random — assert the
			// stamp count on the human's folded row, never a particular glyph.
			const foldRow = recapPanel.locator(
				'#poker-recap li.poker-recap-action[data-seat="0"][data-action="fold"]',
			);
			await expect(foldRow).toBeVisible();
			await expect(foldRow.locator('.poker-recap-grade')).toHaveCount(1);
			await expect(foldRow.locator('.poker-recap-grade')).toBeVisible();

			// The tally counts stamped decisions only: exactly one graded fold.
			await expect(recapPanel.locator('#recap-grade-tally')).toHaveText(/⭐ \d\/1/);
		} finally {
			await context.close();
		}
	});

	test('a signed-in player sees mission rings beside their seat', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedPokerPage(browser, baseURL);
		try {
			const missions = page.getByRole('group', { name: 'Missions' });
			await expect(missions).toBeVisible();
			await expect(missions.getByRole('button', { name: /^Three Wins: .* of 3$/ })).toBeVisible();
		} finally {
			await context.close();
		}
	});
});
