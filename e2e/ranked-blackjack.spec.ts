import { expect, test, type Browser, type Page } from '@playwright/test';
import {
	blackjackRunPublicStateSchema,
	type BlackjackRunPublicState,
} from '../src/lib/blackjack-run/protocol';
import { createIsolatedPage } from './isolated-page';

/** Ranked-only view of the closed public-state union. */
type RankedState = Extract<BlackjackRunPublicState, { mode: 'ranked' }>;

const RUNS_BASE = '/api/blackjack-runs';
const RANKED_WAGER = 10;
const ACTIVE_RUN_ATTEMPTS = 5;
const ADDITIONAL_STAKE_ATTEMPTS = 5;

function isRankedStart(url: string, method: string): boolean {
	return new URL(url).pathname === RUNS_BASE && method === 'POST';
}

function isRankedCurrent(url: string, method: string): boolean {
	const parsed = new URL(url);
	return (
		parsed.pathname === `${RUNS_BASE}/current` &&
		parsed.searchParams.get('mode') === 'ranked' &&
		method === 'GET'
	);
}

function isRankedCommands(url: string, method: string, runId: string): boolean {
	return new URL(url).pathname === `${RUNS_BASE}/${runId}/commands` && method === 'POST';
}

function parseRankedState(text: string): RankedState {
	const state: BlackjackRunPublicState = blackjackRunPublicStateSchema.parse(
		JSON.parse(text) as unknown,
	);
	expect(state.mode).toBe('ranked');
	return state as RankedState;
}

function formatChips(value: number): string {
	return `$${value.toLocaleString('en-US')}`;
}

function formatChipsPill(value: number): string {
	return `${value.toLocaleString('en-US')} chips`;
}

async function headerBalance(page: Page): Promise<number> {
	const text = (await page.locator('[data-chip-balance]').first().textContent())?.trim() ?? '';
	const match = /^([\d,]+) chips$/.exec(text);
	expect(match, `header balance text was "${text}"`).not.toBeNull();
	return Number(match?.[1]?.replaceAll(',', ''));
}

async function openRankedPage(browser: Browser, baseURL: string | undefined, emailPrefix: string) {
	return createIsolatedPage(browser, baseURL, {
		emailPrefix,
		namePrefix: 'Ranked Run E2E',
		navigate: (page) => page.goto('/games/blackjack/ranked', { waitUntil: 'domcontentloaded' }),
	});
}

/**
 * Starts a ranked run and returns the first ACTIVE opening. Opening naturals
 * settle immediately; the run is retried on the same user after a reload
 * (a settled run does not block a new start). `balanceBefore` is the known
 * server balance (header pill) read right before the start click.
 */
async function startActiveRun(
	page: Page,
): Promise<{ runId: string; state: RankedState; balanceBefore: number }> {
	for (let attempt = 1; attempt <= ACTIVE_RUN_ATTEMPTS; attempt += 1) {
		if (attempt > 1) {
			await page.reload({ waitUntil: 'domcontentloaded' });
		}
		await expect(page.getByTestId('ranked-start')).toBeEnabled();
		const balanceBefore = await headerBalance(page);
		await page.getByTestId('ranked-wager').fill(String(RANKED_WAGER));
		const [, startResponse] = await Promise.all([
			page.waitForRequest((request) => isRankedStart(request.url(), request.method())),
			page.waitForResponse((response) =>
				isRankedStart(response.url(), response.request().method()),
			),
			page.getByTestId('ranked-start').click(),
		]);
		expect(startResponse.ok()).toBe(true);
		const state = parseRankedState(await startResponse.text());
		expect(state.mode).toBe('ranked');
		if (state.status !== 'active') {
			// Opening natural settled immediately; retry on the same user.
			continue;
		}
		return { runId: state.runId, state, balanceBefore };
	}
	throw new Error(`Could not obtain an active ranked opening in ${ACTIVE_RUN_ATTEMPTS} attempts`);
}

/** Plays stand and returns the terminal response. */
async function standToTerminal(
	page: Page,
	runId: string,
): Promise<{ commandBody: Record<string, unknown>; state: RankedState }> {
	const [commandRequest, commandResponse] = await Promise.all([
		page.waitForRequest((request) => isRankedCommands(request.url(), request.method(), runId)),
		page.waitForResponse((response) =>
			isRankedCommands(response.url(), response.request().method(), runId),
		),
		page.getByTestId('ranked-action-stand').click(),
	]);
	expect(commandResponse.ok()).toBe(true);
	const rawBody = commandRequest.postData();
	expect(rawBody).not.toBeNull();
	const commandBody = JSON.parse(rawBody as string) as Record<string, unknown>;
	const state = parseRankedState(await commandResponse.text());
	expect(state.status).toBe('settled');
	return { commandBody, state };
}

async function assertNoLegacyRankedArtifacts(page: Page): Promise<void> {
	// No receipt/hash/commitment/version DOM from the legacy ranked stack.
	const legacySelectors = [
		'[data-testid="ranked-receipt"]',
		'[data-testid="ranked-receipt-id"]',
		'[data-testid="ranked-receipt-hash"]',
		'[data-testid="ranked-stats"]',
		'[data-testid="ranked-achievement-toast"]',
	];
	await expect(page.locator(legacySelectors.join(','))).toHaveCount(0);
	// No wallet-lock / multiplayer overlap copy.
	await expect(page.getByText('cannot overlap multiplayer', { exact: false })).toHaveCount(0);
	// No legacy or new localStorage state for ranked runs.
	expect(
		await page.evaluate(() =>
			Object.keys(localStorage).filter((key) =>
				['arcturus:ranked-blackjack:start-request:', 'arcturus:ranked-blackjack:session:'].some(
					(prefix) => key.startsWith(prefix),
				),
			),
		),
	).toEqual([]);
	expect(
		await page.evaluate(() =>
			Object.keys(localStorage).filter((key) => key.includes('blackjack-run')),
		),
	).toEqual([]);
}

test.describe('ranked blackjack run', () => {
	test('starts an authenticated run at a known balance and debits the initial stake immediately', async ({
		browser,
		baseURL,
	}) => {
		const isolated = await openRankedPage(browser, baseURL, 'ranked-run-start');

		try {
			await expect(isolated.page.getByTestId('ranked-start')).toBeEnabled();

			// Known starting balance: SSR root attribute and header pill agree.
			const rootBalance = Number(
				await isolated.page
					.getByTestId('ranked-blackjack-root')
					.getAttribute('data-initial-balance'),
			);
			expect(Number.isSafeInteger(rootBalance)).toBe(true);
			expect(rootBalance).toBeGreaterThanOrEqual(RANKED_WAGER);
			expect(await headerBalance(isolated.page)).toBe(rootBalance);

			const { runId, state, balanceBefore } = await startActiveRun(isolated.page);

			// The initial stake is debited from the server balance at once…
			expect(state.balance).toBe(balanceBefore - RANKED_WAGER);
			expect(state.committedWager).toBe(RANKED_WAGER);
			expect(state.nextSequence).toBe(0);
			expect(state.outcome).toBeNull();
			expect(state.expiresAt).toBeGreaterThan(Math.trunc(Date.now() / 1000));

			// …and the header pill + in-table balance reflect it immediately.
			await expect(isolated.page.locator('[data-chip-balance]').first()).toHaveText(
				formatChipsPill(state.balance),
			);
			await expect(isolated.page.getByTestId('ranked-balance')).toHaveText(
				formatChips(state.balance),
			);
			await expect(isolated.page.getByTestId('ranked-committed-wager')).toHaveText('$10');

			// The active opening shows only the server-projected dealer card.
			await expect(
				isolated.page.locator('[data-testid="ranked-dealer-hand"] > .playing-card'),
			).toHaveCount(1);
			await expect(isolated.page.getByTestId('ranked-start')).toBeDisabled();
			await expect(isolated.page.getByTestId('ranked-action-stand')).toBeEnabled();

			expect(runId).toMatch(/^[A-Za-z0-9_-]{22}$/);
		} finally {
			await isolated.context.close();
		}
	});

	test('drives a command through the new endpoint and renders the terminal Result', async ({
		browser,
		baseURL,
	}) => {
		const isolated = await openRankedPage(browser, baseURL, 'ranked-run-command');

		try {
			const { runId, state } = await startActiveRun(isolated.page);

			const { commandBody, state: terminal } = await standToTerminal(isolated.page, runId);

			// The command is stamped with the server-provided current sequence.
			expect(commandBody).toEqual({ sequence: state.nextSequence, command: 'stand' });

			// Terminal projection: full dealer hand, no legal actions, outcome.
			expect(terminal.status).toBe('settled');
			expect(terminal.phase).toBe('complete');
			// The hole card is revealed; the dealer may draw further cards.
			expect(terminal.dealer.cards.length).toBeGreaterThanOrEqual(2);
			expect(terminal.availableActions).toEqual([]);
			expect(terminal.outcome).not.toBeNull();
			// The initial stake was already debited at start; the terminal
			// credits the gross payout on top of the post-debit balance.
			expect(terminal.balance).toBe(state.balance + (terminal.outcome?.payout ?? 0));

			// Result panel: outcome, committed wager, payout, net, final balance.
			await expect(isolated.page.getByTestId('ranked-result')).toBeVisible();
			const outcome = terminal.outcome!;
			await expect(isolated.page.getByTestId('ranked-result-outcome')).toHaveText(
				outcome.result === 'win' ? 'Win' : outcome.result === 'loss' ? 'Loss' : 'Push',
			);
			await expect(isolated.page.getByTestId('ranked-result-wager')).toHaveText(
				formatChips(outcome.committedWager),
			);
			await expect(isolated.page.getByTestId('ranked-result-payout')).toHaveText(
				formatChips(outcome.payout),
			);
			const expectedNet =
				outcome.gameNetDelta === 0
					? '$0'
					: `${outcome.gameNetDelta > 0 ? '+' : '-'}${formatChips(Math.abs(outcome.gameNetDelta))}`;
			await expect(isolated.page.getByTestId('ranked-result-net')).toHaveText(expectedNet);
			await expect(isolated.page.getByTestId('ranked-result-balance')).toHaveText(
				formatChips(terminal.balance),
			);
			await expect(isolated.page.locator('[data-chip-balance]').first()).toHaveText(
				formatChipsPill(terminal.balance),
			);
			// Terminal releases the start control.
			await expect(isolated.page.getByTestId('ranked-start')).toBeEnabled();
		} finally {
			await isolated.context.close();
		}
	});

	test('reload resumes the active run from the server', async ({ browser, baseURL }) => {
		const isolated = await openRankedPage(browser, baseURL, 'ranked-run-resume');

		try {
			const { runId, state } = await startActiveRun(isolated.page);

			const [currentResponse] = await Promise.all([
				isolated.page.waitForResponse((response) =>
					isRankedCurrent(response.url(), response.request().method()),
				),
				isolated.page.reload({ waitUntil: 'domcontentloaded' }),
			]);
			expect(currentResponse.ok()).toBe(true);
			const resumed = parseRankedState(await currentResponse.text());

			// Same run, same sequence, same balance — the run was never lost.
			expect(resumed.runId).toBe(runId);
			expect(resumed.status).toBe('active');
			expect(resumed.nextSequence).toBe(state.nextSequence);
			expect(resumed.balance).toBe(state.balance);
			expect(resumed.committedWager).toBe(state.committedWager);

			await expect(isolated.page.getByTestId('ranked-balance')).toHaveText(
				formatChips(resumed.balance),
			);
			await expect(isolated.page.locator('[data-chip-balance]').first()).toHaveText(
				formatChipsPill(resumed.balance),
			);
			await expect(
				isolated.page.locator('[data-testid="ranked-dealer-hand"] > .playing-card'),
			).toHaveCount(1);
			await expect(isolated.page.getByTestId('ranked-start')).toBeDisabled();
			await expect(isolated.page.getByTestId('ranked-action-stand')).toBeEnabled();
		} finally {
			await isolated.context.close();
		}
	});

	test('split/double debits the additional stake when the dealt hand allows', async ({
		browser,
		baseURL,
	}) => {
		const isolated = await openRankedPage(browser, baseURL, 'ranked-run-additional-stake');

		try {
			for (let attempt = 1; attempt <= ADDITIONAL_STAKE_ATTEMPTS; attempt += 1) {
				const { runId, state } = await startActiveRun(isolated.page);

				const additionalStakeAction = (['split', 'double-down'] as const).find((action) =>
					state.availableActions.includes(action),
				);

				if (!additionalStakeAction) {
					// No split/double fixture on this opening; settle the run
					// and try a fresh opening (a settled run frees the start).
					await standToTerminal(isolated.page, runId);
					continue;
				}

				const activeHandWager =
					state.playerHands[state.activeHandIndex]?.wager ?? state.committedWager;
				const [commandRequest, commandResponse] = await Promise.all([
					isolated.page.waitForRequest((request) =>
						isRankedCommands(request.url(), request.method(), runId),
					),
					isolated.page.waitForResponse((response) =>
						isRankedCommands(response.url(), response.request().method(), runId),
					),
					isolated.page.getByTestId(`ranked-action-${additionalStakeAction}`).click(),
				]);
				expect(commandResponse.ok()).toBe(true);
				expect(JSON.parse(commandRequest.postData() ?? '{}')).toEqual({
					sequence: state.nextSequence,
					command: additionalStakeAction,
				});
				const after = parseRankedState(await commandResponse.text());

				// The additional stake is debited from the account balance.
				expect(after.committedWager).toBe(state.committedWager + activeHandWager);
				if (after.status === 'active') {
					// Split keeps the round open: balance drops by exactly the
					// additional stake.
					expect(after.balance).toBe(state.balance - activeHandWager);
				} else {
					// Double-down completes and settles in the same command:
					// the payout is credited on top of the additional debit.
					expect(after.status).toBe('settled');
					expect(after.balance).toBe(
						state.balance - activeHandWager + (after.outcome?.payout ?? 0),
					);
				}
				await expect(isolated.page.locator('[data-chip-balance]').first()).toHaveText(
					formatChipsPill(after.balance),
				);
				await expect(isolated.page.getByTestId('ranked-balance')).toHaveText(
					formatChips(after.balance),
				);
				return;
			}
			test.skip(
				true,
				`no split/double fixture appeared in ${ADDITIONAL_STAKE_ATTEMPTS} openings; the debited-balance invariant was not exercisable`,
			);
		} finally {
			await isolated.context.close();
		}
	});

	test('terminal credits the payout once, allows a second run, and drops legacy ranked artifacts', async ({
		browser,
		baseURL,
	}) => {
		const isolated = await openRankedPage(browser, baseURL, 'ranked-run-terminal');
		try {
			const { runId, state } = await startActiveRun(isolated.page);

			const { commandBody, state: terminal } = await standToTerminal(isolated.page, runId);

			// The payout is credited exactly once: the initial stake was debited
			// at start, so the terminal balance is the post-debit balance plus
			// the gross payout.
			expect(terminal.balance).toBe(state.balance + (terminal.outcome?.payout ?? 0));

			// Re-reading the run does not credit again.
			const resumed = await isolated.page.request.get(`${RUNS_BASE}/${runId}`);
			expect(resumed.ok()).toBe(true);
			const resumedState = parseRankedState(await resumed.text());
			expect(resumedState.balance).toBe(terminal.balance);

			// Replaying the exact terminal command is idempotent (no double credit).
			const replayed = await isolated.page.request.post(`${RUNS_BASE}/${runId}/commands`, {
				data: JSON.stringify(commandBody),
				headers: { 'content-type': 'application/json' },
			});
			expect(replayed.ok()).toBe(true);
			const replayedState = parseRankedState(await replayed.text());
			expect(replayedState.balance).toBe(terminal.balance);

			// The terminal Result is rendered.
			await expect(isolated.page.getByTestId('ranked-result')).toBeVisible();
			await expect(isolated.page.getByTestId('ranked-result-balance')).toHaveText(
				formatChips(terminal.balance),
			);

			// A second ranked run can start after the terminal.
			await expect(isolated.page.getByTestId('ranked-start')).toBeEnabled();
			await isolated.page.getByTestId('ranked-wager').fill(String(RANKED_WAGER));
			const [, secondStart] = await Promise.all([
				isolated.page.waitForRequest((request) => isRankedStart(request.url(), request.method())),
				isolated.page.waitForResponse((response) =>
					isRankedStart(response.url(), response.request().method()),
				),
				isolated.page.getByTestId('ranked-start').click(),
			]);
			expect(secondStart.ok()).toBe(true);
			const second = parseRankedState(await secondStart.text());
			expect(second.runId).not.toBe(runId);
			expect(second.mode).toBe('ranked');
			expect(['active', 'settled']).toContain(second.status);
			// The second start debits another initial stake (a settled opening
			// natural also credits its payout on top of the same debit).
			expect(second.balance).toBe(terminal.balance - RANKED_WAGER + (second.outcome?.payout ?? 0));
			await expect(isolated.page.locator('[data-chip-balance]').first()).toHaveText(
				formatChipsPill(second.balance),
			);

			// Old receipt/hash/localStorage behavior is absent.
			await assertNoLegacyRankedArtifacts(isolated.page);
		} finally {
			await isolated.context.close();
		}
	});
});
