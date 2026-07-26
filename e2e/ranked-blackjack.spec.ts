import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { z } from 'zod';
import type { RankedBlackjackResponseV1 } from '../src/lib/ranked/blackjack/client';
import {
	createRankedPublicStateV1Schema,
	rankedAchievementEffectsV1Schema,
	rankedActionSchema,
	rankedBalanceSchema,
	rankedRewardEffectsV1Schema,
	rankedStatsEffectsV1Schema,
	safeIntegerSchema,
	sessionIdSchema,
} from '../src/lib/ranked/protocol';
import { createIsolatedPage } from './isolated-page';

const RANKED_START_PATH = '/api/ranked/sessions';
const ACTIVE_SESSION_ATTEMPTS = 5;
const RANKED_WAGER = 10;
const PRIVATE_STATE_MARKERS = [
	'seed',
	'deck',
	'generator',
	'hole',
	'private',
	'prng',
	'rng',
	'randomstate',
] as const;

const rankedCardSchema = z
	.object({
		rank: z.enum(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']),
		suit: z.enum(['hearts', 'diamonds', 'clubs', 'spades']),
	})
	.strict();

const rankedHandValueSchema = z
	.object({
		value: safeIntegerSchema,
		isSoft: z.boolean(),
		isBust: z.boolean(),
	})
	.strict();

const rankedHandSchema = z
	.object({
		cards: z.array(rankedCardSchema),
		wager: safeIntegerSchema.min(0),
		value: rankedHandValueSchema,
	})
	.strict();

const rankedOutcomeSchema = z
	.object({
		result: z.enum(['win', 'loss', 'push']),
		hands: z.array(
			z
				.object({
					handIndex: safeIntegerSchema.min(0),
					result: z.enum(['win', 'loss', 'push', 'blackjack']),
					wager: safeIntegerSchema.min(0),
					payout: safeIntegerSchema.min(0),
				})
				.strict(),
		),
		committedWager: safeIntegerSchema.min(0),
		payout: safeIntegerSchema.min(0),
		gameNetDelta: safeIntegerSchema,
	})
	.strict();

const rankedBrowserStateSchema = z
	.object({
		phase: z.enum(['player-turn', 'complete']),
		playerHands: z.array(rankedHandSchema),
		activeHandIndex: safeIntegerSchema.min(0),
		dealer: z
			.object({
				cards: z.array(rankedCardSchema),
				value: rankedHandValueSchema,
			})
			.strict(),
		committedWager: safeIntegerSchema.min(0),
		nextSequence: safeIntegerSchema.min(0),
		availableActions: z.array(rankedActionSchema),
		outcome: rankedOutcomeSchema.nullable(),
	})
	.strict();

const rankedReceiptSchema = z
	.object({
		sessionId: sessionIdSchema,
		gameType: z.literal('blackjack'),
		rulesetVersion: z.literal('blackjack-ranked-v1'),
		seedCommitment: z.string(),
		configHash: z.string(),
		actionLogHash: z.string(),
		outcome: rankedOutcomeSchema,
		initialWager: safeIntegerSchema.min(0),
		committedWager: safeIntegerSchema.min(0),
		payout: safeIntegerSchema.min(0),
		gameNetDelta: safeIntegerSchema,
		rewardDelta: safeIntegerSchema.min(0),
		balanceAfter: rankedBalanceSchema,
		statsEffects: rankedStatsEffectsV1Schema,
		achievementEffects: rankedAchievementEffectsV1Schema,
		rewardEffects: rankedRewardEffectsV1Schema,
		settledAt: safeIntegerSchema.min(0),
		receiptHash: z.string(),
	})
	.strict();

const rankedResponseSchema = createRankedPublicStateV1Schema(
	rankedBrowserStateSchema,
	rankedReceiptSchema,
);

type ActiveRankedPage = {
	context: BrowserContext;
	page: Page;
	initialBalance: number;
	startResponse: RankedBlackjackResponseV1;
};

function isRankedStart(url: string, method: string): boolean {
	return new URL(url).pathname === RANKED_START_PATH && method === 'POST';
}

function isRankedSessionRequest(
	url: string,
	method: string,
	sessionId: string,
	suffix = '',
): boolean {
	return (
		new URL(url).pathname === `${RANKED_START_PATH}/${sessionId}${suffix}` && method === 'POST'
	);
}

function normalizePrivacyMarker(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertNoPrivateMarker(value: string, location: string): void {
	const normalized = normalizePrivacyMarker(value).replaceAll('seedcommitment', '');
	const marker = PRIVATE_STATE_MARKERS.find((candidate) => normalized.includes(candidate));
	if (marker) {
		throw new Error(`Private ranked state marker "${marker}" found at ${location}`);
	}
}

function assertNoPrivateRankedValue(value: unknown, location = '$'): void {
	if (typeof value === 'string') {
		assertNoPrivateMarker(value, location);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => assertNoPrivateRankedValue(entry, `${location}[${index}]`));
		return;
	}
	if (typeof value !== 'object' || value === null) return;

	for (const [key, entry] of Object.entries(value)) {
		if (normalizePrivacyMarker(key) !== 'seedcommitment') {
			assertNoPrivateMarker(key, `${location}.${key}`);
		}
		assertNoPrivateRankedValue(entry, `${location}.${key}`);
	}
}

function expectNoPrivateRankedState(response: RankedBlackjackResponseV1): void {
	assertNoPrivateRankedValue(response);
	if (response.status === 'active') {
		expect(response.state.dealer.cards).toHaveLength(1);
	}
}

function parseRankedResponse(value: unknown): RankedBlackjackResponseV1 {
	assertNoPrivateRankedValue(value);
	const response = rankedResponseSchema.parse(value);
	expectNoPrivateRankedState(response);
	return response;
}

function parseRankedResponseText(text: string): RankedBlackjackResponseV1 {
	return parseRankedResponse(JSON.parse(text) as unknown);
}

async function expectActiveDomIsPublic(page: Page): Promise<void> {
	const dealerHand = page.locator('#ranked-dealer-hand');
	await expect(dealerHand).toHaveCount(1);
	await expect(dealerHand.locator(':scope > .playing-card')).toHaveCount(1);
	expect(await dealerHand.evaluate((element) => element.children.length)).toBe(1);

	// Scan only data-* attribute values and <script> text content for private
	// markers, not the entire document HTML. Whole-document substring matching
	// after normalization false-positives on ordinary CSS class names, visible
	// text, and unrelated UI copy (e.g. "deck" in a tooltip, "hole" in help
	// text). Data attributes and inline scripts are the actual leak vectors.
	const [dataAttrValues, scriptContents] = await Promise.all([
		page.evaluate(() => {
			const values: string[] = [];
			for (const el of document.querySelectorAll('*')) {
				for (const attr of el.attributes) {
					if (attr.name.startsWith('data-')) {
						values.push(`${attr.name}=${attr.value}`);
					}
				}
			}
			return values;
		}),
		page.evaluate(() =>
			Array.from(document.querySelectorAll('script')).map((s) => s.textContent ?? ''),
		),
	]);

	for (const value of dataAttrValues) {
		assertNoPrivateMarker(value, 'data attribute');
	}
	for (const content of scriptContents) {
		assertNoPrivateMarker(content, 'script content');
	}
}

async function createActiveRankedPage(
	browser: Browser,
	baseURL: string | undefined,
	emailPrefix: string,
): Promise<ActiveRankedPage> {
	for (let attempt = 1; attempt <= ACTIVE_SESSION_ATTEMPTS; attempt += 1) {
		const candidate = await createIsolatedPage(browser, baseURL, {
			emailPrefix: `${emailPrefix}-${attempt}`,
			namePrefix: 'Ranked Blackjack E2E',
			navigate: (page) => page.goto('/games/blackjack/ranked', { waitUntil: 'domcontentloaded' }),
		});

		try {
			await expect(candidate.page).toHaveURL(/\/games\/blackjack\/ranked$/);
			await expect(candidate.page.getByTestId('ranked-start')).toBeEnabled();
			const initialBalanceValue = await candidate.page
				.getByTestId('ranked-blackjack-root')
				.getAttribute('data-initial-balance');
			const initialBalance = Number(initialBalanceValue);
			expect(Number.isSafeInteger(initialBalance)).toBe(true);
			expect(initialBalance).toBeGreaterThanOrEqual(RANKED_WAGER);

			await candidate.page.getByTestId('ranked-wager').fill(String(RANKED_WAGER));
			const [startRequest, startResponse] = await Promise.all([
				candidate.page.waitForRequest((request) => isRankedStart(request.url(), request.method())),
				candidate.page.waitForResponse((response) =>
					isRankedStart(response.url(), response.request().method()),
				),
				candidate.page.getByTestId('ranked-start').click(),
			]);
			expect(startResponse.ok()).toBe(true);
			const startText = await startResponse.text();
			const response = parseRankedResponseText(startText);

			const startBody = startRequest.postData();
			expect(startBody).not.toBeNull();
			const replayedStart = await candidate.page.request.post(RANKED_START_PATH, {
				data: startBody as string,
				headers: { 'content-type': 'application/json' },
			});
			expect(replayedStart.ok()).toBe(true);
			const replayedStartText = await replayedStart.text();
			expect(replayedStartText).toBe(startText);
			parseRankedResponseText(replayedStartText);

			if (response.status !== 'active') {
				await candidate.context.close();
				continue;
			}

			await expectActiveDomIsPublic(candidate.page);
			return {
				...candidate,
				initialBalance,
				startResponse: response,
			};
		} catch (error) {
			await candidate.context.close();
			throw error;
		}
	}

	throw new Error(
		`Could not obtain an active ranked opening in ${ACTIVE_SESSION_ATTEMPTS} attempts`,
	);
}

test.describe('ranked secrecy guard self-tests', () => {
	test('rejects normalized private-state variants while allowing seedCommitment', () => {
		expect(() =>
			assertNoPrivateRankedValue({
				seedCommitment: 'public-hash',
			}),
		).not.toThrow();

		const representativeLeaks = [
			{ nested: { serverSeed: 'private' } },
			{ nested: { shuffledDeck: [] } },
			{ nested: { deckCursor: 4 } },
			{ nested: { dealerHoleCard: { rank: 'K', suit: 'clubs' } } },
			{ nested: { privateRngState: 'private' } },
		];

		for (const leak of representativeLeaks) {
			expect(() => assertNoPrivateRankedValue(leak)).toThrow();
		}
	});

	test('rejects private state hidden in ranked markup', async ({ page }) => {
		await page.setContent(`
			<main
				data-testid="ranked-blackjack-root"
				data-server-seed="private"
			>
				<div id="ranked-dealer-hand">
					<div class="playing-card" data-testid="ranked-dealer-card">A♠</div>
				</div>
				<script type="application/json">
					{"dealerHoleCard":{"rank":"K","suit":"clubs"}}
				</script>
			</main>
		`);

		await expect(expectActiveDomIsPublic(page)).rejects.toThrow();
	});
});

test.describe('ranked Blackjack', () => {
	test('settles once and exact start/action retries return the stored receipt', async ({
		browser,
		baseURL,
	}) => {
		const active = await createActiveRankedPage(browser, baseURL, 'ranked-settlement');

		try {
			expect(active.startResponse.balance).toBe(active.initialBalance - RANKED_WAGER);
			expect(active.startResponse.state.committedWager).toBe(RANKED_WAGER);
			expect(active.startResponse.receipt).toBeNull();

			await expectActiveDomIsPublic(active.page);

			const sessionId = active.startResponse.sessionId;
			const [terminalRequest, terminalResponse] = await Promise.all([
				active.page.waitForRequest((request) =>
					isRankedSessionRequest(request.url(), request.method(), sessionId, '/actions'),
				),
				active.page.waitForResponse((response) =>
					isRankedSessionRequest(
						response.url(),
						response.request().method(),
						sessionId,
						'/actions',
					),
				),
				active.page.getByTestId('ranked-action-stand').click(),
			]);
			expect(terminalResponse.ok()).toBe(true);
			const terminalText = await terminalResponse.text();
			const terminal = parseRankedResponseText(terminalText);
			expect(terminal.status).toBe('settled');
			expect(terminal.receipt).not.toBeNull();
			expect(terminal.receipt?.sessionId).toBe(sessionId);
			expect(terminal.receipt?.receiptHash).toMatch(/^[a-f0-9]{64}$/);
			expect(terminal.receipt?.rewardDelta).toBe(100);
			expect(terminal.receipt?.rewardEffects).toEqual([
				{ rewardId: 'ranked_debut_100', chipAmount: 100 },
			]);

			await expect(active.page.getByTestId('ranked-receipt')).toBeVisible();
			await expect(active.page.getByTestId('ranked-receipt-id')).toHaveText(sessionId);
			await expect(active.page.getByTestId('ranked-receipt-hash')).toHaveText(
				terminal.receipt?.receiptHash ?? '',
			);
			await expect(active.page.getByTestId('ranked-balance')).toHaveText(
				`$${terminal.balance.toLocaleString('en-US')}`,
			);
			await expect(active.page.getByTestId('ranked-stats')).toContainText('1 played');
			await expect(active.page.getByTestId('ranked-stats')).toContainText('net');

			const terminalBody = terminalRequest.postData();
			expect(terminalBody).not.toBeNull();
			const replayedTerminal = await active.page.request.post(
				`${RANKED_START_PATH}/${sessionId}/actions`,
				{
					data: terminalBody as string,
					headers: { 'content-type': 'application/json' },
				},
			);
			expect(replayedTerminal.ok()).toBe(true);
			const replayedTerminalText = await replayedTerminal.text();
			expect(replayedTerminalText).toBe(terminalText);

			const resumed = await active.page.request.get(`${RANKED_START_PATH}/${sessionId}`);
			expect(resumed.ok()).toBe(true);
			const resumedBody = parseRankedResponseText(await resumed.text());
			expect(resumedBody.balance).toBe(terminal.balance);
			expect(resumedBody.receipt).toEqual(terminal.receipt);
		} finally {
			await active.context.close();
		}
	});

	test('reloads the same active sequence and refreshes cross-tab balance restrictions', async ({
		browser,
		baseURL,
	}) => {
		const active = await createActiveRankedPage(browser, baseURL, 'ranked-recovery');

		try {
			const sessionId = active.startResponse.sessionId;
			const nextSequence = active.startResponse.nextSequence;

			const firstResumePromise = active.page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === `${RANKED_START_PATH}/${sessionId}` &&
					response.request().method() === 'GET',
			);
			await active.page.reload({ waitUntil: 'domcontentloaded' });
			const firstResumeResponse = await firstResumePromise;
			expect(firstResumeResponse.ok()).toBe(true);
			const firstResume = parseRankedResponseText(await firstResumeResponse.text());
			expect(firstResume.sessionId).toBe(sessionId);
			expect(firstResume.nextSequence).toBe(nextSequence);
			await expectActiveDomIsPublic(active.page);

			const casualPage = await active.context.newPage();
			await casualPage.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
			await expect(casualPage.getByText('Casual', { exact: true })).toBeVisible();
			const casualUpdate = await casualPage.request.post('/api/chips/update', {
				data: {
					syncId: `ranked-cross-tab-${sessionId}`,
					gameType: 'blackjack',
					previousBalance: firstResume.balance,
					delta: -firstResume.balance,
				},
			});
			expect(casualUpdate.ok()).toBe(true);
			expect((await casualUpdate.json()) as { balance: number }).toMatchObject({ balance: 0 });

			const refreshedResumePromise = active.page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === `${RANKED_START_PATH}/${sessionId}` &&
					response.request().method() === 'GET',
			);
			await active.page.reload({ waitUntil: 'domcontentloaded' });
			const refreshedResumeResponse = await refreshedResumePromise;
			expect(refreshedResumeResponse.ok()).toBe(true);
			const refreshedResume = parseRankedResponseText(await refreshedResumeResponse.text());
			expect(refreshedResume.sessionId).toBe(sessionId);
			expect(refreshedResume.nextSequence).toBe(nextSequence);
			expect(refreshedResume.balance).toBe(0);
			expect(refreshedResume.state.availableActions).not.toContain('double-down');
			expect(refreshedResume.state.availableActions).not.toContain('split');
			await expect(active.page.getByTestId('ranked-balance')).toHaveText('$0');
			await expect(active.page.getByTestId('ranked-action-double-down')).toBeDisabled();
			await expect(active.page.getByTestId('ranked-action-split')).toBeDisabled();
			await expectActiveDomIsPublic(active.page);
		} finally {
			await active.context.close();
		}
	});
});
