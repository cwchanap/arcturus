import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	dailyChallengeAttemptPublicStateSchema,
	dailyChallengeChallengeResponseSchema,
	dailyChallengeLeaderboardResponseSchema,
} from '../src/lib/daily-challenge/protocol';
import { createDailyChallengeSeedCommitment } from '../src/lib/daily-challenge/random';
import { encodeBase64Url } from '../src/lib/ranked/canonical';
import { createIsolatedPage } from './isolated-page';

const DAILY_CHALLENGE_PAGE = '/games/daily-challenge';
// Derive the archived day as the previous UTC calendar day so the history/reveal
// scenario stays consistent regardless of when the suite runs.
const previousUtcDay = new Date();
previousUtcDay.setUTCDate(previousUtcDay.getUTCDate() - 1);
const HISTORY_PERIOD_KEY = `${previousUtcDay.getUTCFullYear()}-${String(
	previousUtcDay.getUTCMonth() + 1,
).padStart(2, '0')}-${String(previousUtcDay.getUTCDate()).padStart(2, '0')}`;
const HISTORY_PAGE = `/games/daily-challenge/${HISTORY_PERIOD_KEY}`;
// Noon UTC on the archived day, as epoch seconds, for fixture timestamps.
const HISTORY_SETTLED_AT = Math.floor(
	Date.UTC(
		previousUtcDay.getUTCFullYear(),
		previousUtcDay.getUTCMonth(),
		previousUtcDay.getUTCDate(),
		12,
		0,
		0,
	) / 1000,
);
const ROUND_COUNT = 10;
const RANKED_WAGER = 10;
const ATTEMPTS_START_PATH = '/api/daily-challenges/current/attempts';
const CURRENCY = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 0,
	maximumFractionDigits: 0,
});

function pathname(url: string): string {
	return new URL(url).pathname;
}

function isAttemptStart(url: string, method: string): boolean {
	return pathname(url) === ATTEMPTS_START_PATH && method === 'POST';
}

function isAttemptRead(url: string, method: string): boolean {
	return (
		/^\/api\/daily-challenge-attempts\/[A-Za-z0-9_-]{22}$/.test(pathname(url)) && method === 'GET'
	);
}

function isAttemptCommand(url: string, method: string): boolean {
	return (
		/^\/api\/daily-challenge-attempts\/[A-Za-z0-9_-]{22}\/commands$/.test(pathname(url)) &&
		method === 'POST'
	);
}

function formatCurrency(value: number): string {
	return CURRENCY.format(value);
}

function parseCurrency(text: string | null): number | null {
	const digits = (text ?? '').replace(/[^0-9]/g, '');
	const parsed = Number(digits);
	return digits.length > 0 && Number.isSafeInteger(parsed) ? parsed : null;
}

function roundLabel(completed: number): string {
	return `Round ${Math.min(completed + 1, ROUND_COUNT)} of ${ROUND_COUNT}`;
}

type WriteRecord = { url: string; method: string };

function collectChallengeWrites(page: Page): WriteRecord[] {
	const writes: WriteRecord[] = [];
	page.on('request', (request) => {
		if (request.method() !== 'POST') return;
		const path = pathname(request.url());
		if (
			path === ATTEMPTS_START_PATH ||
			/^\/api\/daily-challenge-attempts\/[A-Za-z0-9_-]+(\/commands)?$/.test(path)
		) {
			writes.push({ url: path, method: request.method() });
		}
	});
	return writes;
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
 * round-progress label cannot distinguish these (replay and ranked rounds
 * reuse labels), so the settled signal is the committed wager returning to
 * '—' with Start Round re-enabled. Both states are stable by the time the
 * poll observes them: the client flips pending synchronously in the click
 * handler, so the poll can never race a stale pre-click render.
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

/**
 * Plays one ranked round through the real API: starts it (unless a player
 * turn is already up, e.g. after a reload) and stands whenever legal.
 */
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

async function startRankedAttempt(
	page: Page,
): Promise<ReturnType<typeof dailyChallengeAttemptPublicStateSchema.parse>> {
	const responsePromise = page.waitForResponse((response) =>
		isAttemptStart(response.url(), response.request().method()),
	);
	await page.getByTestId('daily-challenge-start-ranked').click();
	const response = await responsePromise;
	expect(response.ok()).toBe(true);
	return dailyChallengeAttemptPublicStateSchema.parse(await response.json());
}

const RANKED_SEED = new Uint8Array(32).fill(0x51);
const PRACTICE_SEED = new Uint8Array(32).fill(0x29);
const RANKED_SEED_COMMITMENT = createDailyChallengeSeedCommitment(
	'blackjack-daily-v1',
	RANKED_SEED,
);
const RANKED_SEED_B64 = encodeBase64Url(RANKED_SEED);
const PRACTICE_SEED_B64 = encodeBase64Url(PRACTICE_SEED);

function historicalChallengeFixture(revealedRankedSeed: string | null) {
	return dailyChallengeChallengeResponseSchema.parse({
		periodKey: HISTORY_PERIOD_KEY,
		challengeKind: 'blackjack-daily',
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		startsAt: 1785628800,
		rankedEntryClosesAt: 1785713400,
		endsAt: 1785715200,
		configHash: '0'.repeat(64),
		rankedSeedCommitment: RANKED_SEED_COMMITMENT,
		practiceSeed: PRACTICE_SEED_B64,
		revealedRankedSeed,
		attempt: null,
	});
}

const TIED_LEADERBOARD = dailyChallengeLeaderboardResponseSchema.parse({
	periodKey: HISTORY_PERIOD_KEY,
	entries: [
		{
			rank: 1,
			playerName: 'Alice',
			endingBankroll: 980,
			roundsCompleted: 10,
			durationSeconds: 0,
			settledAt: HISTORY_SETTLED_AT,
		},
		{
			rank: 1,
			playerName: 'Bob',
			endingBankroll: 980,
			roundsCompleted: 10,
			durationSeconds: 0,
			settledAt: HISTORY_SETTLED_AT,
		},
	],
	currentUser: null,
});

test.describe('daily challenge guest practice', () => {
	test('plays and restarts a local round write-free and surfaces the sign-in CTA', async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();
		const writes = collectChallengeWrites(page);
		try {
			await page.goto(DAILY_CHALLENGE_PAGE, { waitUntil: 'domcontentloaded' });

			await expect(page.getByTestId('daily-challenge-controls')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-mode-practice')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-mode-ranked')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toContainText(
				'SIGN IN TO PLAY RANKED',
			);
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText('\u2014');
			await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText('\u2014');
			await expect(page.getByTestId('daily-challenge-round-progress')).toHaveText('\u2014');

			await page.getByTestId('daily-challenge-replay-scenario-practice').click();
			await expect(page.getByTestId('daily-challenge-status')).toHaveText(
				'Start practice to play the local scenario.',
			);
			await page.getByTestId('daily-challenge-start-round').click();
			const state = await waitForTurnOrSettled(page);
			if (state === 'turn') {
				await page.getByTestId('daily-challenge-action-stand').click();
			}
			await expect.poll(() => progressLabel(page)).toBe(roundLabel(1));
			await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText('\u2014');

			await page.getByTestId('daily-challenge-restart-practice').click();
			await expect(page.getByTestId('daily-challenge-status')).toHaveText(
				'Start practice to play the local scenario.',
			);
			await expect(page.getByTestId('daily-challenge-start-round')).toBeEnabled();

			await page.getByTestId('daily-challenge-mode-practice').click();
			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeHidden();

			expect(writes).toHaveLength(0);
		} finally {
			await context.close();
		}
	});
});

test.describe('daily challenge ranked attempt', () => {
	test('runs one real attempt to completion with refresh recovery and no second start', async ({
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

		try {
			await expect(page.getByTestId('daily-challenge-sign-in-cta')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-start-ranked')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText('\u2014');
			await expect(page.getByTestId('daily-challenge-status')).toHaveText(
				'Start your ranked attempt to begin.',
			);

			await page.getByTestId('daily-challenge-wager').fill(String(RANKED_WAGER));
			const started = await startRankedAttempt(page);
			const attemptId = started.attemptId;
			expect(started.status).toBe('active');
			expect(started.availableBankroll).toBe(1000);
			expect(started.roundsCompleted).toBe(0);
			expect(started.receipt).toBeNull();

			await playRankedRound(page, 1);
			await playRankedRound(page, 2);

			// Refresh mid-attempt during a player turn and verify the same
			// attempt, bankroll, round, and committed wager are resumed.
			// Openings that settle on the deal produce no turn; retry with a
			// fresh round a few times, and fall back to the terminal state if
			// every opening settles (vanishingly unlikely).
			let nextRound = 3;
			let refreshed = false;
			for (let attempt = 0; attempt < 3 && !refreshed && nextRound <= ROUND_COUNT; attempt += 1) {
				await page.getByTestId('daily-challenge-start-round').click();
				const state = await waitForTurnOrSettled(page);
				if (state !== 'turn') {
					nextRound += 1;
					continue;
				}
				refreshed = true;
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

				const resumePromise = page.waitForResponse((response) =>
					isAttemptRead(response.url(), response.request().method()),
				);
				await page.reload({ waitUntil: 'domcontentloaded' });
				const resumeResponse = await resumePromise;
				expect(resumeResponse.ok()).toBe(true);
				const resumed = dailyChallengeAttemptPublicStateSchema.parse(await resumeResponse.json());
				expect(resumed.attemptId).toBe(attemptId);
				expect(resumed.roundsCompleted).toBe(nextRound - 1);
				expect(resumed.availableBankroll).toBe(bankrollBefore);
				expect(resumed.activeRound?.committedWager).toBe(RANKED_WAGER);
				await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText(
					formatCurrency(RANKED_WAGER),
				);
				await expect(page.getByTestId('daily-challenge-round-progress')).toHaveText(progressBefore);
			}

			for (let round = nextRound; round <= ROUND_COUNT; round += 1) {
				await playRankedRound(page, round);
			}

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
			await expect(page.getByTestId('daily-challenge-rank')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-rank')).toHaveText(/^#\d+$/);
			await expect(page.getByTestId('daily-challenge-percentile')).toHaveText(
				/^\d+(st|nd|rd|th) percentile$/,
			);

			// The leaderboard and standing render from a page-load fetch, so a
			// reload after completion surfaces the finished entry.
			const periodKey = started.periodKey;
			const leaderboardPromise = page.waitForResponse(
				(response) => pathname(response.url()) === `/api/daily-challenges/${periodKey}/leaderboard`,
			);
			await page.reload({ waitUntil: 'domcontentloaded' });
			const leaderboardResponse = await leaderboardPromise;
			expect(leaderboardResponse.ok()).toBe(true);
			const leaderboard = dailyChallengeLeaderboardResponseSchema.parse(
				await leaderboardResponse.json(),
			);
			expect(leaderboard.entries.length).toBeGreaterThanOrEqual(1);
			expect(leaderboard.currentUser).not.toBeNull();
			expect(leaderboard.currentUser?.rank).toBeGreaterThanOrEqual(1);
			expect(leaderboard.currentUser?.totalEligible).toBeGreaterThanOrEqual(1);
			expect(leaderboard.currentUser?.percentile).toBeGreaterThanOrEqual(0);
			expect(leaderboard.currentUser?.percentile).toBeLessThanOrEqual(100);
			await expect(
				page
					.getByTestId('daily-challenge-leaderboard-row')
					.filter({ hasText: formatCurrency(receiptBankroll as number) }),
			).toHaveCount(1);
			await expect(page.getByTestId('daily-challenge-current-standing')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-current-standing')).toHaveText(
				/^#\d+ \u00b7 \d+%$/,
			);
			await expect(
				page.getByTestId('daily-challenge-history-row').filter({ hasText: periodKey }),
			).toHaveCount(1);
			await expect(
				page.getByTestId('daily-challenge-history-row').filter({ hasText: 'Completed' }),
			).toHaveCount(1);

			// A second start returns the consumed attempt instead of resetting.
			const secondStart = await startRankedAttempt(page);
			expect(secondStart.attemptId).toBe(attemptId);
			expect(secondStart.status).toBe('completed');
			expect(secondStart.receipt).not.toBeNull();
			expect(secondStart.receipt?.attemptId).toBe(attemptId);
			await expect(page.getByTestId('daily-challenge-receipt')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-receipt-eligibility')).toHaveText(
				'Eligible for ranking',
			);
			await expect(page.getByTestId('daily-challenge-bankroll')).toHaveText(
				formatCurrency(receiptBankroll as number),
			);
			await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText('\u2014');
		} finally {
			await context.close();
		}
	});
});

test.describe('daily challenge uncertain and terminal command recovery', () => {
	test('drops one command response, then recovers on the idempotent retry', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedPage(browser, baseURL, {
			emailPrefix: 'dc-drop',
			namePrefix: 'Daily Challenge E2E',
			navigate: (candidate) =>
				candidate.goto(DAILY_CHALLENGE_PAGE, { waitUntil: 'domcontentloaded' }),
		});

		try {
			await page.getByTestId('daily-challenge-wager').fill(String(RANKED_WAGER));
			const started = await startRankedAttempt(page);
			const attemptId = started.attemptId;

			// Forward the first command to the server (it applies), then drop
			// the browser-side response so the client sees an uncertain failure
			// and retries the identical command.
			let dropNext = true;
			const commandBodies: string[] = [];
			await page.route(`**/api/daily-challenge-attempts/${attemptId}/commands`, async (route) => {
				commandBodies.push(route.request().postData() ?? '');
				if (dropNext) {
					dropNext = false;
					await route.fetch();
					await route.abort('connectionfailed');
					return;
				}
				await route.continue();
			});

			await page.getByTestId('daily-challenge-start-round').click();
			const state = await waitForTurnOrSettled(page);

			expect(commandBodies).toHaveLength(2);
			expect(commandBodies[1]).toBe(commandBodies[0]);
			if (state === 'turn') {
				await expect(page.getByTestId('daily-challenge-action-stand')).toBeEnabled();
				await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText(
					formatCurrency(RANKED_WAGER),
				);
			} else {
				await expect(page.getByTestId('daily-challenge-committed-wager')).toHaveText('\u2014');
			}
			await expect(page.getByTestId('daily-challenge-bankroll')).not.toHaveText('\u2014');
			await expect(page.getByTestId('daily-challenge-status')).not.toContainText('failed');
			await expect(page.getByTestId('daily-challenge-status')).not.toContainText('TypeError');
		} finally {
			await context.close();
		}
	});

	test('renders the immutable receipt after an ATTEMPT_COMPLETE fixture', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedPage(browser, baseURL, {
			emailPrefix: 'dc-expiry',
			namePrefix: 'Daily Challenge E2E',
			navigate: (candidate) =>
				candidate.goto(DAILY_CHALLENGE_PAGE, { waitUntil: 'domcontentloaded' }),
		});

		try {
			await page.getByTestId('daily-challenge-wager').fill(String(RANKED_WAGER));
			const started = await startRankedAttempt(page);
			const attemptId = started.attemptId;

			const terminal = dailyChallengeAttemptPublicStateSchema.parse({
				attemptId,
				challengeId: started.challengeId,
				startRequestId: started.startRequestId,
				status: 'expired',
				nextCommandSequence: started.nextCommandSequence,
				availableBankroll: 970,
				roundsCompleted: 3,
				activeRound: null,
				rank: null,
				percentile: null,
				receipt: {
					attemptId,
					challengeId: started.challengeId,
					periodKey: started.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: '0'.repeat(64),
					rankedSeedCommitment: '1'.repeat(64),
					actionLogHash: '2'.repeat(64),
					endingBankroll: 970,
					roundsCompleted: 3,
					eligible: false,
					terminalReason: 'expired',
					durationSeconds: 0,
					settledAt: 1785790000,
					receiptHash: '3'.repeat(64),
				},
				expiresAt: started.expiresAt,
			});

			await page.route(`**/api/daily-challenge-attempts/${attemptId}/commands`, async (route) => {
				await route.fulfill({
					status: 409,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'ATTEMPT_COMPLETE' }),
				});
			});
			await page.route(`**/api/daily-challenge-attempts/${attemptId}`, async (route) => {
				if (route.request().method() === 'GET') {
					await route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify(terminal),
					});
					return;
				}
				await route.continue();
			});

			await page.getByTestId('daily-challenge-start-round').click();

			await expect(page.getByTestId('daily-challenge-receipt')).toBeVisible();
			await expect(page.getByTestId('daily-challenge-receipt-eligibility')).toHaveText(
				'Not eligible for ranking',
			);
			await expect(page.getByTestId('daily-challenge-receipt-rounds')).toHaveText('3 of 10 rounds');
			await expect(page.getByTestId('daily-challenge-receipt-bankroll')).toHaveText('$970');
			await expect(page.getByTestId('daily-challenge-rank')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-percentile')).toBeHidden();
			await expect(page.getByTestId('daily-challenge-status')).not.toContainText('failed');
			await expect(page.getByTestId('daily-challenge-status')).not.toContainText('TypeError');
		} finally {
			await context.close();
		}
	});
});

test.describe('daily challenge historical reveal UI', () => {
	async function installFixtures(page: Page, revealedRankedSeed: string | null): Promise<void> {
		const challenge = historicalChallengeFixture(revealedRankedSeed);
		await page.route(`**/api/daily-challenges/${HISTORY_PERIOD_KEY}`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(challenge),
			});
		});
		await page.route(`**/api/daily-challenges/${HISTORY_PERIOD_KEY}/leaderboard`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(TIED_LEADERBOARD),
			});
		});
	}

	async function playLocalRound(page: Page): Promise<void> {
		await page.getByTestId('daily-challenge-replay-scenario-practice').click();
		await page.getByTestId('daily-challenge-start-round').click();
		const state = await waitForTurnOrSettled(page);
		if (state === 'turn') {
			await page.getByTestId('daily-challenge-action-stand').click();
		}
		await expect.poll(() => progressLabel(page)).toBe(roundLabel(1));
	}

	test('pre-close page commits to the seed without revealing it and replays write-free', async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();
		const writes = collectChallengeWrites(page);
		try {
			await installFixtures(page, null);
			await page.goto(HISTORY_PAGE, { waitUntil: 'domcontentloaded' });

			await expect(page.getByTestId('daily-challenge-reveal-status')).toHaveText(
				'Ranked seed not yet revealed',
			);
			await expect(page.getByTestId('daily-challenge-commitment')).toHaveText(
				RANKED_SEED_COMMITMENT,
			);
			await expect(page.getByTestId('daily-challenge-replay-scenario-exact-ranked')).toBeDisabled();
			await expect(page.getByTestId('daily-challenge-replay-scenario-practice')).toBeEnabled();

			await playLocalRound(page);

			const rows = page.getByTestId('daily-challenge-leaderboard-row');
			await expect(rows).toHaveCount(2);
			await expect(rows.nth(0)).toHaveText(/^#1 Alice \$980$/);
			await expect(rows.nth(1)).toHaveText(/^#1 Bob \$980$/);
			await expect(rows.nth(0)).not.toContainText(/playing|live|active/i);
			await expect(page.getByTestId('daily-challenge-current-standing')).toBeHidden();

			expect(writes).toHaveLength(0);
		} finally {
			await context.close();
		}
	});

	test('closed page verifies the revealed seed and enables both replay modes', async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();
		const writes = collectChallengeWrites(page);
		try {
			await installFixtures(page, RANKED_SEED_B64);
			await page.goto(HISTORY_PAGE, { waitUntil: 'domcontentloaded' });

			await expect(page.getByTestId('daily-challenge-reveal-status')).toHaveText(
				'Commitment verified',
			);
			await expect(page.getByTestId('daily-challenge-commitment')).toHaveText(
				RANKED_SEED_COMMITMENT,
			);
			await expect(page.getByTestId('daily-challenge-replay-scenario-exact-ranked')).toBeEnabled();
			await expect(page.getByTestId('daily-challenge-replay-scenario-practice')).toBeEnabled();

			await page.getByTestId('daily-challenge-replay-scenario-exact-ranked').click();
			await page.getByTestId('daily-challenge-start-round').click();
			await waitForTurnOrSettled(page);

			await playLocalRound(page);

			await expect(page.getByTestId('daily-challenge-current-standing')).toBeHidden();
			expect(writes).toHaveLength(0);
		} finally {
			await context.close();
		}
	});
});
