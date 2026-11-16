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

type Box = { left: number; right: number; top: number; bottom: number };

/** Axis-aligned rectangle intersection; touching edges do not count. */
const boxesOverlap = (a: Box, b: Box) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Board with the five poker-eligible ring IDs (the rerolled daily shape from
 * the table-missions unit tests), so the table renders a full five-ring row
 * for deterministic layout checks.
 */
function boardWithFivePokerRings() {
	const view = (missionDefId: string, period: 'daily' | 'weekly') => ({
		missionDefId,
		icon: '\u2660\uFE0F',
		period,
		progress: 0,
		target: 3,
		completed: false,
		claimed: false,
		claimable: false,
		rewardChips: 500,
		isOverride: missionDefId === 'daily-poker-wins-3' || missionDefId === 'daily-poker-big-pot',
	});
	return {
		streak: {
			current: 0,
			longest: 0,
			claimableToday: false,
			dayOfCycle: 1,
			rewardPreview: 0,
			lastClaimPeriodKey: '',
		},
		daily: ['daily-win-3', 'daily-poker-10', 'daily-poker-wins-3', 'daily-poker-big-pot'].map(
			(id) => view(id, 'daily'),
		),
		weekly: [view('weekly-poker-wins-15', 'weekly')],
		rerollAvailable: false,
		nextDailyReset: new Date(Date.now() + 86_400_000).toISOString(),
		nextWeeklyReset: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		chipBalance: 1000,
	};
}

test.describe('Poker turn flow smoke test', () => {
	test('deal, human action, AI acts, next phase continues', async ({ browser, baseURL }) => {
		// A 6-max hand runs several AI orbits per street; allow time for a full hand.
		test.setTimeout(120000);
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
		// Human folds preflop, then five AIs finish the hand; the re-deal loop
		// alone can burn ~60s of waits before the 45s recap wait, so budget both.
		test.setTimeout(120000);
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
				// click() can resolve before dealNewHand updates the status, so the
				// regex below would match the previous hand's terminal text; wait
				// for the new hand's history group first (status is overwritten in
				// the same synchronous task that creates it).
				await expect(page.locator('#poker-history .poker-history-hand')).toHaveCount(attempt + 1, {
					timeout: 10000,
				});
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
		// A full hand (AI orbits plus async settlement) needs the same budget as
		// the turn-flow smoke above.
		test.setTimeout(120000);
		const { context, page } = await createIsolatedPokerPage(browser, baseURL);
		try {
			const missions = page.getByRole('group', { name: 'Missions' });
			await expect(missions).toBeVisible();
			await expect(missions.getByRole('button', { name: /^Three Wins: .* of 3$/ })).toBeVisible();
			const pokerTen = missions.locator('[data-mission-id="daily-poker-10"]');
			await expect(pokerTen).toBeVisible();

			// Same speed setup as the turn-flow smoke: keeps AI orbits quick.
			await page.getByRole('button', { name: /configure/i }).click();
			await page.locator('#setting-ai-speed').selectOption('fast');
			await page
				.getByRole('dialog', { name: 'Game Settings' })
				.getByRole('button', { name: 'Save Settings' })
				.click();

			// A timer-forced fold would still settle, but it could race the
			// manual fold below — disable the clock like the recap test does.
			const timerToggle = page.locator('#btn-turn-timer');
			await expect(timerToggle).toHaveAttribute('aria-pressed', 'true');
			await timerToggle.click();
			await expect(timerToggle).toHaveAttribute('aria-pressed', 'false');

			// Deal once: fold when the human gets a legal turn, or accept an AI
			// preflop walkover — both settle exactly one completed hand. With the
			// timer off the hand cannot pass the human's turn, so the status
			// always ends at one of the two outcomes.
			const status = page.locator('#game-status');
			const handEndedOrYourTurn = /Your turn|wins? .* chips|Tie!.*split the .* chips pot|Showdown/i;
			await page.locator('#btn-deal').click();
			// click() can resolve before dealNewHand updates the status, so wait
			// for the new hand's history group first (same guard as the recap
			// test).
			await expect(page.locator('#poker-history .poker-history-hand')).toHaveCount(1, {
				timeout: 10000,
			});
			await expect(status).toHaveText(handEndedOrYourTurn, { timeout: 10000 });
			if (/Your turn/i.test((await status.textContent()) ?? '')) {
				await page.locator('#btn-fold').click();
			}

			// The recap button appears only once the hand is settled; the settled
			// event fired around it is what makes the table refresh the board.
			await expect(page.locator('#btn-recap')).toBeVisible({ timeout: 45000 });
			await expect(pokerTen).toHaveText(/1\/10/, { timeout: 15000 });
		} finally {
			await context.close();
		}
	});

	test('five mission rings stay clear of bankroll, cards and actions at 1101px, 1281px and 320px', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedPage(browser, baseURL, {
			emailPrefix: 'poker-sync',
			namePrefix: 'Poker Sync',
		});
		try {
			// Route must exist before the poker page loads: the table fetches the
			// board on init, and a stable five-ring board keeps geometry
			// deterministic (independent of the live missions catalog).
			await page.route('**/api/missions/board', (route) =>
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(boardWithFivePokerRings()),
				}),
			);

			const ringTokens = page.locator('#poker-missions .poker-mission');
			const ringPosition = () =>
				page.evaluate(() => getComputedStyle(document.getElementById('poker-missions')!).position);
			const measure = async () =>
				page.evaluate(() => {
					const box = (el: Element): Box => {
						const r = el.getBoundingClientRect();
						return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
					};
					// Ring circles plus their count badges (badges hang below the
					// circle and must stay clear of neighbours too).
					const rings = [
						...document.querySelectorAll(
							'#poker-missions .poker-mission, #poker-missions .poker-mission-count',
						),
					].map(box);
					return {
						rings,
						bankroll: box(document.querySelector('.poker-bankroll')!),
						cards: box(document.querySelector('#player-cards')!),
						actions: box(document.querySelector('.poker-actions')!),
					};
				});
			const assertNoCollisions = async () => {
				const m = await measure();
				expect(m.rings).toHaveLength(10); // 5 circles + 5 count badges
				for (const [index, ring] of m.rings.entries()) {
					expect(boxesOverlap(ring, m.bankroll), `ring ${index} overlaps bankroll`).toBe(false);
					expect(boxesOverlap(ring, m.cards), `ring ${index} overlaps cards`).toBe(false);
					expect(boxesOverlap(ring, m.actions), `ring ${index} overlaps actions`).toBe(false);
				}
				return m;
			};

			// 1101px: desktop width inside the ring-row breakpoint — the rings
			// get their own centered row instead of absolute placement.
			await page.setViewportSize({ width: 1101, height: 900 });
			await page.goto(`${baseURL}/games/poker`, { waitUntil: 'networkidle' });
			await expect(ringTokens).toHaveCount(5);
			await expect.poll(ringPosition).toBe('static');
			await assertNoCollisions();

			// 1281px: one pixel past the breakpoint — the absolute seat-side
			// placement returns and must also be collision-free.
			await page.setViewportSize({ width: 1281, height: 900 });
			await expect(ringTokens).toHaveCount(5);
			await expect.poll(ringPosition).toBe('absolute');
			await assertNoCollisions();

			// 320px: narrowest supported width — the centered five-ring row must
			// still fit inside the viewport.
			await page.setViewportSize({ width: 320, height: 900 });
			await expect(ringTokens).toHaveCount(5);
			await expect.poll(ringPosition).toBe('static');
			const narrow = await assertNoCollisions();
			const row = narrow.rings.reduce(
				(acc, ring) => ({
					left: Math.min(acc.left, ring.left),
					right: Math.max(acc.right, ring.right),
					top: Math.min(acc.top, ring.top),
					bottom: Math.max(acc.bottom, ring.bottom),
				}),
				{ left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
			);
			expect(row.left).toBeGreaterThanOrEqual(0);
			expect(row.right).toBeLessThanOrEqual(320);
			expect(Math.abs((row.left + row.right) / 2 - 160)).toBeLessThanOrEqual(4);
		} finally {
			await context.close();
		}
	});
});
