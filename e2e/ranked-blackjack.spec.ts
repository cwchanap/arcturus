import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RankedBlackjackResponseV1 } from '../src/lib/ranked/blackjack/client';
import { createIsolatedPage } from './isolated-page';

const RANKED_START_PATH = '/api/ranked/sessions';
const ACTIVE_SESSION_ATTEMPTS = 5;
const RANKED_WAGER = 10;

type ActiveRankedPage = {
	context: BrowserContext;
	page: Page;
	initialBalance: number;
	startBody: string;
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

function expectNoPrivateRankedState(response: RankedBlackjackResponseV1): void {
	const serialized = JSON.stringify(response);
	expect(serialized).not.toMatch(
		/"(?:seed|deck|generatorState|rngState|prngState|randomState)"\s*:/i,
	);
	if (response.status === 'active') {
		expect(response.state.dealer.cards).toHaveLength(1);
	}
}

async function expectActiveDomIsPublic(page: Page): Promise<void> {
	await expect(page.getByTestId('ranked-dealer-card')).toHaveCount(1);
	const rankedText = await page.getByTestId('ranked-blackjack-root').innerText();
	expect(rankedText).not.toMatch(/\b(?:seed|deck|generator state|rng state|prng state)\b/i);
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
			const response = (await startResponse.json()) as RankedBlackjackResponseV1;
			expectNoPrivateRankedState(response);

			if (response.status !== 'active') {
				await candidate.context.close();
				continue;
			}

			const startBody = startRequest.postData();
			expect(startBody).not.toBeNull();
			await expectActiveDomIsPublic(candidate.page);
			return {
				...candidate,
				initialBalance,
				startBody: startBody as string,
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

			const replayedStart = await active.page.request.post(RANKED_START_PATH, {
				data: active.startBody,
				headers: { 'content-type': 'application/json' },
			});
			expect(replayedStart.ok()).toBe(true);
			const replayedStartBody = (await replayedStart.json()) as RankedBlackjackResponseV1;
			expectNoPrivateRankedState(replayedStartBody);
			expect(replayedStartBody.sessionId).toBe(active.startResponse.sessionId);
			expect(replayedStartBody.balance).toBe(active.startResponse.balance);
			expect(replayedStartBody.state.committedWager).toBe(RANKED_WAGER);
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
			const terminal = JSON.parse(terminalText) as RankedBlackjackResponseV1;
			expectNoPrivateRankedState(terminal);
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
			const resumedBody = (await resumed.json()) as RankedBlackjackResponseV1;
			expectNoPrivateRankedState(resumedBody);
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
			const firstResume = (await firstResumeResponse.json()) as RankedBlackjackResponseV1;
			expectNoPrivateRankedState(firstResume);
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
			const refreshedResume = (await refreshedResumeResponse.json()) as RankedBlackjackResponseV1;
			expectNoPrivateRankedState(refreshedResume);
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
