import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	blackjackRunPublicStateSchema,
	type BlackjackRunPublicState,
} from '../src/lib/blackjack-run/protocol';
import { formatPoints } from '../src/lib/blackjack-run/daily-ui';
import { createIsolatedPage } from './isolated-page';

/**
 * Daily Challenge E2E on the unified Blackjack Run APIs (HPA-553 Task 7).
 *
 * Proves, in order:
 *  1. guest current Daily/leaderboard load (Task 5 guest surface);
 *  2. Practice works with ZERO `POST /api/blackjack-runs`;
 *  3. authenticated one-attempt start;
 *  4. the new command endpoint drives rounds;
 *  5. reload resumes the run;
 *  6. an eligible terminal appears in the leaderboard;
 *  7. rank/percentile/current-user standing renders;
 *  8. a second attempt is unavailable;
 *  9. the old history/replay UI is absent.
 */

const DAILY_CHALLENGE_PAGE = '/games/daily-challenge';
const RUNS_BASE = '/api/blackjack-runs';
const GUEST_CURRENT_PATH = '/api/blackjack-daily/current';
const WEEKLY_LEADERBOARD_PATH = '/api/blackjack-daily/weekly-leaderboard';
const ROUND_COUNT = 10;
const RANKED_WAGER = 10;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const CURRENCY = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 0,
	maximumFractionDigits: 0,
});

function formatCurrency(value: number): string {
	return CURRENCY.format(value);
}

function parseCurrency(text: string | null): number | null {
	const digits = (text ?? '').replace(/[^0-9]/g, '');
	const parsed = Number(digits);
	return digits.length > 0 && Number.isSafeInteger(parsed) ? parsed : null;
}

function pathname(url: string): string {
	return new URL(url).pathname;
}

function isRunStart(url: string, method: string): boolean {
	return pathname(url) === RUNS_BASE && method === 'POST';
}

function isRunCurrentDaily(url: string, method: string): boolean {
	const parsed = new URL(url);
	return (
		parsed.pathname === `${RUNS_BASE}/current` &&
		parsed.searchParams.get('mode') === 'daily' &&
		method === 'GET'
	);
}

function isRunCommand(url: string, method: string): boolean {
	return (
		/^\/api\/blackjack-runs\/[A-Za-z0-9_-]{22}\/commands$/.test(pathname(url)) && method === 'POST'
	);
}

function isGuestCurrent(url: string, method: string): boolean {
	return pathname(url) === GUEST_CURRENT_PATH && method === 'GET';
}

function isDailyLeaderboard(url: string, method: string): boolean {
	return (
		/^\/api\/blackjack-daily\/\d{4}-\d{2}-\d{2}\/leaderboard$/.test(pathname(url)) &&
		method === 'GET'
	);
}

function isWeeklyLeaderboard(url: string, method: string): boolean {
	return pathname(url) === WEEKLY_LEADERBOARD_PATH && method === 'GET';
}

function isLegacyDailyEndpoint(url: string): boolean {
	return /\/api\/(daily-challenges|daily-challenge-attempts)/.test(pathname(url));
}

function parseDailyState(text: string): Extract<BlackjackRunPublicState, { mode: 'daily' }> {
	const state: BlackjackRunPublicState = blackjackRunPublicStateSchema.parse(
		JSON.parse(text) as unknown,
	);
	expect(state.mode).toBe('daily');
	return state as Extract<BlackjackRunPublicState, { mode: 'daily' }>;
}

type WriteRecord = { url: string; method: string };

/** Records every POST the page issues — Practice must produce none. */
function collectPosts(page: Page): WriteRecord[] {
	const posts: WriteRecord[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST') {
			posts.push({ url: pathname(request.url()), method: request.method() });
		}
	});
	return posts;
}

function recordVisitedUrls(page: Page): string[] {
	const urls: string[] = [];
	page.on('request', (request) => {
		urls.push(request.url());
	});
	return urls;
}

function roundLabel(completed: number): string {
	return `Round ${Math.min(completed + 1, ROUND_COUNT)} of ${ROUND_COUNT}`;
}

async function isStandEnabled(page: Page): Promise<boolean> {
	return page
		.getByTestId('daily-challenge-action-stand')
		.isEnabled()
		.catch(() => false);
}

async function isReceiptVisible(page: Page): Promise<boolean> {
	return page
		.getByTestId('daily-challenge-receipt')
		.isVisible()
		.catch(() => false);
}

async function progressLabel(page: Page): Promise<string> {
	return (await page.getByTestId('daily-challenge-round-progress').textContent()) ?? '';
}

/**
 * Waits until the round is either awaiting player input ('turn', Stand
 * enabled) or already settled by the deal ('settled', e.g. a natural). The
 * settled signal is the committed wager returning to '—' with Start Round
 * re-enabled. Daily practice flips state synchronously in the click handler
 * and ranked commands render before pending releases, so the poll can never
 * race a stale pre-click render.
 */
async function waitForTurnOrSettled(page: Page): Promise<'turn' | 'settled'> {
	let state: 'turn' | 'settled' | 'waiting' = 'waiting';
	await expect
		.poll(async () => {
			if (await isStandEnabled(page)) {
				state = 'turn';
			} else {
				const committed = await page.getByTestId('daily-challenge-committed-wager').textContent();
				const startRoundEnabled = await page
					.getByTestId('daily-challenge-start-round')
					.isEnabled()
					.catch(() => false);
				state = committed === '\u2014' && startRoundEnabled ? 'settled' : 'waiting';
			}
			return state;
		})
		.toMatch(/^(turn|settled)$/);
	return state;
}

/** Plays one ranked round through the new command endpoint: stand when legal. */
async function playRankedRound(page: Page, round: number): Promise<void> {
	if (!(await isStandEnabled(page))) {
		await page.getByTestId('daily-challenge-start-round').click();
	}
	const state = await waitForTurnOrSettled(page);
	if (state !== 'turn') return;
	await page.getByTestId('daily-challenge-action-stand').click();
	await expect
		.poll(async () => {
			if (round === ROUND_COUNT) return (await isReceiptVisible(page)) ? 'done' : 'pending';
			return (await progressLabel(page)) === roundLabel(round) ? 'done' : 'pending';
		})
		.toBe('done');
}

async function assertNoLegacyDailyUi(page: Page): Promise<void> {
	// Proof 9: the historical replay page, seven-day history, seed
	// commitment/reveal copy, and replay-scenario controls are all gone.
	const legacySelectors = [
		'[data-testid="daily-challenge-history"]',
		'[data-testid="daily-challenge-history-rows"]',
		'[data-testid="daily-challenge-history-link"]',
		'[data-testid="daily-challenge-replay-scenario-exact-ranked"]',
		'[data-testid="daily-challenge-replay-scenario-practice"]',
		'[data-testid="daily-challenge-commitment"]',
		'[data-testid="daily-challenge-reveal-status"]',
	];
	await expect(page.locator(legacySelectors.join(','))).toHaveCount(0);
	expect(
		await page.evaluate(() =>
			Object.keys(localStorage).filter((key) => key.toLowerCase().includes('daily')),
		),
	).toEqual([]);
}

test.describe('daily challenge — guest surface and browser-local practice', () => {
	test('loads the guest current/leaderboard surface and plays practice with zero run POSTs', async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({
			baseURL,
			storageState: { cookies: [], origins: [] },
		});
		const page = await context.newPage();
		const posts = collectPosts(page);
		const requestedUrls = recordVisitedUrls(page);

		try {
			const guestWeeklyResponse = page.waitForResponse((response) =>
				isWeeklyLeaderboard(response.url(), response.request().method()),
			);
			const [guestCurrent, leaderboard] = await Promise.all([
				page.waitForResponse((response) =>
					isGuestCurrent(response.url(), response.request().method()),
				),
				page.waitForResponse((response) =>
					isDailyLeaderboard(response.url(), response.request().method()),
				),
				page.goto(DAILY_CHALLENGE_PAGE, { waitUntil: 'domcontentloaded' }),
			]);

			expect((await guestWeeklyResponse).ok()).toBe(true);
			await expect(page.getByTestId('daily-challenge-weekly-leaderboard')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-weekly-error')).toBeHidden();

			// Proof 1: the Task 5 guest surface answers a definitive 404
			// RUN_NOT_FOUND, and the leaderboard is guest-readable.
			expect(guestCurrent.status()).toBe(404);
			expect(await guestCurrent.json()).toEqual({ error: 'RUN_NOT_FOUND' });
			expect(leaderboard.ok()).toBe(true);
			const leaderboardBody = (await leaderboard.json()) as { entries: unknown[] };
			expect(Array.isArray(leaderboardBody.entries)).toBe(true);

			await expect(page.getByTestId('daily-challenge-controls')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-mode-practice')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-mode-ranked')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toContainText(
				'Sign in to play Ranked',
			);
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeHidden();

			// Practice starts immediately at the virtual bankroll.
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText(formatCurrency(1000));
			await expect(page.getByTestId('daily-challenge-round-progress')).toHaveText(roundLabel(0));

			// Proof 2: a fully local round — no POST of any kind.
			await page.getByTestId('daily-challenge-wager').fill(String(RANKED_WAGER));
			await page.getByTestId('daily-challenge-start-round').click();
			let state = await waitForTurnOrSettled(page);
			if (state === 'turn') {
				await page.getByTestId('daily-challenge-action-stand').click();
			}
			await expect.poll(() => progressLabel(page)).toBe(roundLabel(1));

			// Restart deals a fresh browser-local scenario.
			await page.getByTestId('daily-challenge-restart-practice').click();
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText(formatCurrency(1000));
			await expect(page.getByTestId('daily-challenge-round-progress')).toHaveText(roundLabel(0));
			await page.getByTestId('daily-challenge-start-round').click();
			state = await waitForTurnOrSettled(page);
			if (state === 'turn') {
				await page.getByTestId('daily-challenge-action-stand').click();
			}
			await expect.poll(() => progressLabel(page)).toBe(roundLabel(1));

			// Leaderboard rows render for guests from the public endpoint. The
			// container must be visible even when the day has no entries yet, so
			// an empty leaderboard is still distinguishable from a missing one.
			await expect(page.getByTestId('daily-challenge-leaderboard-rows')).toBeVisible();
			const rows = page.getByTestId('daily-challenge-leaderboard-row');
			const rowCount = await rows.count();
			for (let index = 0; index < rowCount; index += 1) {
				await expect(rows.nth(index)).toHaveText(/^#\d+ .+ \$[\d,]+$/);
			}
			await expect(page.getByTestId('daily-challenge-current-standing')).toBeHidden();

			// No run writes, no legacy daily endpoints (also Proof 9's network half).
			expect(posts).toHaveLength(0);
			expect(requestedUrls.some((url) => isLegacyDailyEndpoint(url))).toBe(false);
			expect(
				await page.evaluate(() =>
					Object.keys(localStorage).filter((key) => key.toLowerCase().includes('daily')),
				),
			).toEqual([]);

			await assertNoLegacyDailyUi(page);
		} finally {
			await context.close();
		}
	});
});

test.describe('daily challenge — authenticated ranked attempt', () => {
	test('runs one real daily attempt to an eligible terminal with resume, standing, and no second start', async ({
		browser,
		baseURL,
	}) => {
		test.setTimeout(120_000);
		const { context, page } = await createIsolatedPage(browser, baseURL, {
			emailPrefix: 'dc-ranked',
			namePrefix: 'Daily Challenge E2E',
			navigate: (candidate) =>
				candidate.goto(DAILY_CHALLENGE_PAGE, { waitUntil: 'domcontentloaded' }),
		});
		const requestedUrls = recordVisitedUrls(page);

		try {
			// A fresh user has no daily run: the shared client's current load
			// resolves the definitive 404 and the page shows the idle start form.
			const initialCurrent = page.waitForResponse((response) =>
				isRunCurrentDaily(response.url(), response.request().method()),
			);
			await page.reload({ waitUntil: 'domcontentloaded' });
			const initialCurrentResponse = await initialCurrent;
			expect(initialCurrentResponse.status()).toBe(404);
			expect(await initialCurrentResponse.json()).toEqual({ error: 'RUN_NOT_FOUND' });

			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-mode-ranked')).toBeVisible();
			// The page defaults to Practice; switching to Ranked shows the idle
			// start form for a user without an attempt.
			await page.getByTestId('daily-challenge-mode-ranked').click();
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeEnabled();
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText('\u2014');
			await expect(page.getByTestId('daily-challenge-status')).toHaveText(
				'Start your ranked attempt to begin.',
			);

			const periodKey = (await page
				.locator('#daily-challenge-root')
				.getAttribute('data-period-key')) as string;
			expect(periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);

			// Proof 3: the single authenticated start goes through the unified
			// run API with a daily body.
			await page.getByTestId('daily-challenge-wager').fill(String(RANKED_WAGER));
			const [startRequest, startResponse] = await Promise.all([
				page.waitForRequest((request) => isRunStart(request.url(), request.method())),
				page.waitForResponse((response) => isRunStart(response.url(), response.request().method())),
				page.getByTestId('daily-challenge-start-ranked').click(),
			]);
			expect(startResponse.ok()).toBe(true);
			expect(JSON.parse(startRequest.postData() ?? '{}')).toEqual({
				mode: 'daily',
				requestId: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
				periodKey,
			});
			const started = parseDailyState(await startResponse.text());
			const runId = started.runId;
			expect(runId).toMatch(RUN_ID_PATTERN);
			expect(started.status).toBe('active');
			expect(started.availableBankroll).toBe(1000);
			expect(started.roundsCompleted).toBe(0);
			expect(started.activeRound).toBeNull();

			// The active attempt routes all controls to the server and hides
			// the start button.
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText(formatCurrency(1000));
			await expect(page.getByTestId('daily-challenge-round-progress')).toHaveText(roundLabel(0));

			// Proof 4: rounds are driven by the new command endpoint, stamped
			// with the server-provided sequence.
			const [firstCommandRequest, firstCommandResponse] = await Promise.all([
				page.waitForRequest(
					(request) =>
						isRunCommand(request.url(), request.method()) &&
						pathname(request.url()) === `${RUNS_BASE}/${runId}/commands`,
				),
				page.waitForResponse(
					(response) =>
						isRunCommand(response.url(), response.request().method()) &&
						pathname(response.url()) === `${RUNS_BASE}/${runId}/commands`,
				),
				page.getByTestId('daily-challenge-start-round').click(),
			]);
			expect(firstCommandResponse.ok()).toBe(true);
			expect(JSON.parse(firstCommandRequest.postData() ?? '{}')).toEqual({
				sequence: started.nextCommandSequence,
				command: 'start-round',
				wager: RANKED_WAGER,
			});
			const afterFirstRound = parseDailyState(await firstCommandResponse.text());
			expect(afterFirstRound.nextCommandSequence).toBe(started.nextCommandSequence + 1);
			if (afterFirstRound.activeRound) {
				await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText(
					formatCurrency(RANKED_WAGER),
				);
			}
			await playRankedRound(page, 1);

			// Proof 5: reload mid-run resumes the same run from the server.
			let nextRound = 2;
			let resumedOnce = false;
			for (let attempt = 0; attempt < 3 && !resumedOnce && nextRound <= ROUND_COUNT; attempt += 1) {
				await page.getByTestId('daily-challenge-start-round').click();
				const state = await waitForTurnOrSettled(page);
				if (state !== 'turn') {
					nextRound += 1;
					continue;
				}
				resumedOnce = true;
				const committedBefore = await page
					.getByTestId('daily-challenge-committed-wager')
					.textContent();
				const bankrollBefore = parseCurrency(
					await page.getByTestId('daily-challenge-bankroll').textContent(),
				);
				const progressBefore = await progressLabel(page);
				expect(committedBefore).toBe(formatCurrency(RANKED_WAGER));
				expect(bankrollBefore).not.toBeNull();
				expect(progressBefore).toBe(roundLabel(nextRound - 1));

				const currentReload = page.waitForResponse((response) =>
					isRunCurrentDaily(response.url(), response.request().method()),
				);
				await page.reload({ waitUntil: 'domcontentloaded' });
				const currentReloadResponse = await currentReload;
				expect(currentReloadResponse.ok()).toBe(true);
				const resumed = parseDailyState(await currentReloadResponse.text());
				expect(resumed.runId).toBe(runId);
				expect(resumed.status).toBe('active');
				expect(resumed.roundsCompleted).toBe(nextRound - 1);
				expect(resumed.availableBankroll).toBe(bankrollBefore);
				expect(resumed.activeRound?.committedWager).toBe(RANKED_WAGER);
				await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText(
					formatCurrency(RANKED_WAGER),
				);
				await expect(page.getByTestId('daily-challenge-round-progress')).toHaveText(progressBefore);
				await expect(page.getByTestId('daily-challenge-start-ranked')).toBeHidden();
			}
			expect(resumedOnce).toBe(true);

			for (let round = nextRound; round <= ROUND_COUNT; round += 1) {
				await playRankedRound(page, round);
			}

			// Eligible terminal: completed all rounds with a bankroll at or
			// above the minimum wager.
			await expect(page.getByTestId('daily-challenge-receipt')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-receipt-eligibility')).toHaveText(
				'Eligible for ranking',
			);
			await expect(page.getByTestId('daily-challenge-receipt-rounds')).toHaveText(
				`${ROUND_COUNT} of ${ROUND_COUNT} rounds`,
			);
			const receiptBankroll = parseCurrency(
				await page.getByTestId('daily-challenge-receipt-bankroll').textContent(),
			);
			expect(receiptBankroll).not.toBeNull();
			expect(receiptBankroll as number).toBeGreaterThanOrEqual(RANKED_WAGER);
			await expect(page.getByTestId('daily-challenge-rank')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-rank')).toHaveText(/^#\d+$/);
			await expect(page.getByTestId('daily-challenge-percentile')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-percentile')).toHaveText(
				/^\d+(st|nd|rd|th) percentile$/,
			);

			// Proofs 6 + 7: the eligible terminal appears in the leaderboard,
			// and the current-user standing renders rank/totalEligible/percentile.
			const dailyLeaderboardReload = page.waitForResponse((response) =>
				isDailyLeaderboard(response.url(), response.request().method()),
			);
			const weeklyLeaderboardReload = page.waitForResponse((response) =>
				isWeeklyLeaderboard(response.url(), response.request().method()),
			);
			await page.reload({ waitUntil: 'domcontentloaded' });
			const dailyLeaderboardResponse = await dailyLeaderboardReload;
			const weeklyLeaderboardResponse = await weeklyLeaderboardReload;
			expect(dailyLeaderboardResponse.ok()).toBe(true);
			expect(weeklyLeaderboardResponse.ok()).toBe(true);
			const leaderboard = (await dailyLeaderboardResponse.json()) as {
				entries: Array<{ dailyEndingBankroll: number }>;
				currentUser: { rank: number; totalEligible: number; percentile: number } | null;
			};
			expect(
				leaderboard.entries.some(
					(entry) => entry.dailyEndingBankroll === (receiptBankroll as number),
				),
			).toBe(true);
			expect(leaderboard.currentUser).not.toBeNull();
			const { rank, totalEligible, percentile } = leaderboard.currentUser!;
			expect(rank).toBeGreaterThanOrEqual(1);
			expect(totalEligible).toBeGreaterThanOrEqual(1);
			expect(percentile).toBeGreaterThanOrEqual(0);
			expect(percentile).toBeLessThanOrEqual(100);
			await expect(page.getByTestId('daily-challenge-current-standing')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-current-standing')).toHaveText(
				`#${rank} · ${percentile}% · ${totalEligible} eligible`,
			);
			// The terminal bankroll appears as a leaderboard row. Prior local-D1
			// runs on the same day can tie the bankroll, so at-least-one is the
			// contract (the API assertion above pins the entry itself).
			const matchingRows = await page
				.getByTestId('daily-challenge-leaderboard-row')
				.filter({ hasText: formatCurrency(receiptBankroll as number) })
				.count();
			expect(matchingRows).toBeGreaterThanOrEqual(1);

			const weekly = (await weeklyLeaderboardResponse.json()) as {
				entries: Array<{
					rank: number;
					playerName: string;
					weeklyScore: number;
					daysPlayed: number;
				}>;
				currentUser: {
					rank: number;
					totalEligible: number;
					weeklyScore: number;
					daysPlayed: number;
				} | null;
			};
			expect(weekly.currentUser).not.toBeNull();
			expect(weekly.currentUser).toMatchObject({
				weeklyScore: receiptBankroll as number,
				daysPlayed: 1,
			});

			const standing = weekly.currentUser!;
			await expect(page.getByTestId('daily-challenge-weekly-current-standing')).toHaveText(
				`#${standing.rank} of ${standing.totalEligible} · ${formatPoints(standing.weeklyScore)} pts · 1/7 days`,
			);
			if (standing.rank <= 50) {
				const matchingRows = await page
					.getByTestId('daily-challenge-weekly-leaderboard-row')
					.filter({
						hasText: `#${standing.rank} ${formatPoints(standing.weeklyScore)} pts · 1/7 days`,
					})
					.count();
				expect(matchingRows).toBeGreaterThanOrEqual(1);
			}

			// Proof 8: the one attempt per period is spent. The UI forbids a
			// restart and the server returns the same completed run.
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeDisabled();
			const secondStart = await page.request.post(RUNS_BASE, {
				data: JSON.stringify({
					mode: 'daily',
					requestId: `e2e-second-${Math.random().toString(36).slice(2)}-${Date.now()}`,
					periodKey,
				}),
				headers: { 'content-type': 'application/json' },
			});
			expect(secondStart.ok()).toBe(true);
			const second = parseDailyState(await secondStart.text());
			expect(second.runId).toBe(runId);
			expect(second.status).toBe('completed');
			expect(second.eligible).toBe(true);
			await expect(page.getByTestId('daily-challenge-receipt')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-receipt-eligibility')).toHaveText(
				'Eligible for ranking',
			);

			// Proof 9 (network + DOM): no legacy daily endpoints or UI.
			expect(requestedUrls.some((url) => isLegacyDailyEndpoint(url))).toBe(false);
			await assertNoLegacyDailyUi(page);
		} finally {
			await context.close();
		}
	});
});
