import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type {
	DailyChallengeActiveRoundV1,
	DailyChallengeAttemptPublicStateV1,
	DailyChallengeHistoryResponse,
	DailyChallengeLeaderboardResponse,
	DailyChallengePublicResponse,
	DailyChallengeReceiptV1,
} from './protocol';
import type { DailyChallengeReplayV1 } from './replay';
import { createDailyChallengeRenderer, type DailyChallengeRendererHandlers } from './ui';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});

afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

const ATTEMPT_ID = 'abcdefghijklmnopqrstuv';
const CHALLENGE_ID = 'challenge_12345678';
const PERIOD_KEY = '2026-03-14';

const PRACTICE_SEED = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';
const RANKED_SEED = 'UVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVE';

const ACTIVE_ROUND: DailyChallengeActiveRoundV1 = {
	phase: 'player-turn',
	playerHands: [
		{
			cards: [
				{ rank: 'A', suit: 'hearts' },
				{ rank: '9', suit: 'diamonds' },
			],
			wager: 100,
			value: { value: 20, isSoft: true, isBust: false },
		},
	],
	activeHandIndex: 0,
	dealer: {
		cards: [{ rank: '7', suit: 'spades' }],
		value: { value: 7, isSoft: false, isBust: false },
	},
	committedWager: 100,
	availableActions: ['hit', 'stand'],
	outcome: null,
};

const FULL_ACTIONS_ROUND = {
	...ACTIVE_ROUND,
	availableActions: ['hit', 'stand', 'double-down', 'split'],
};

function challengeFixture(
	overrides: Partial<DailyChallengePublicResponse> = {},
): DailyChallengePublicResponse {
	return {
		periodKey: PERIOD_KEY,
		challengeKind: 'blackjack-daily',
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		startsAt: 1_742_000_000,
		rankedEntryClosesAt: 1_742_086_200,
		endsAt: 1_742_086_400,
		configHash: 'a'.repeat(64),
		rankedSeedCommitment: 'b'.repeat(64),
		practiceSeed: PRACTICE_SEED,
		revealedRankedSeed: null,
		attempt: null,
		...overrides,
	};
}

function closedChallengeFixture(): DailyChallengePublicResponse {
	return challengeFixture({
		startsAt: 1_742_000_000,
		rankedEntryClosesAt: 1_742_086_200,
		endsAt: 1_742_086_400,
		revealedRankedSeed: RANKED_SEED,
	});
}

function receiptFixture(overrides: Partial<DailyChallengeReceiptV1> = {}): DailyChallengeReceiptV1 {
	return {
		attemptId: ATTEMPT_ID,
		challengeId: CHALLENGE_ID,
		periodKey: PERIOD_KEY,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configHash: 'a'.repeat(64),
		rankedSeedCommitment: 'b'.repeat(64),
		actionLogHash: 'c'.repeat(64),
		endingBankroll: 1200,
		roundsCompleted: 10,
		eligible: true,
		terminalReason: 'completed',
		durationSeconds: 600,
		settledAt: 1_742_001_000,
		receiptHash: 'd'.repeat(64),
		...overrides,
	};
}

function attemptFixture(
	overrides: Partial<DailyChallengeAttemptPublicStateV1> = {},
): DailyChallengeAttemptPublicStateV1 {
	return {
		attemptId: ATTEMPT_ID,
		challengeId: CHALLENGE_ID,
		startRequestId: 'request_1234567890',
		status: 'active',
		nextCommandSequence: 0,
		availableBankroll: 1000,
		roundsCompleted: 0,
		activeRound: ACTIVE_ROUND,
		rank: null,
		percentile: null,
		receipt: null,
		expiresAt: 1_742_100_000,
		...overrides,
	};
}

function terminalAttemptFixture(
	overrides: Partial<DailyChallengeAttemptPublicStateV1> = {},
): DailyChallengeAttemptPublicStateV1 {
	return {
		...attemptFixture(),
		status: 'completed',
		nextCommandSequence: 40,
		availableBankroll: 1200,
		roundsCompleted: 10,
		activeRound: null,
		rank: 3,
		percentile: 95.5,
		receipt: receiptFixture(),
		...overrides,
	};
}

function leaderboardFixture(
	overrides: Partial<DailyChallengeLeaderboardResponse> = {},
): DailyChallengeLeaderboardResponse {
	return {
		periodKey: PERIOD_KEY,
		entries: [
			{
				rank: 1,
				playerName: 'Alice',
				endingBankroll: 2000,
				roundsCompleted: 10,
				durationSeconds: 300,
				settledAt: 1_742_000_000,
			},
			{
				rank: 2,
				playerName: 'Bob',
				endingBankroll: 1800,
				roundsCompleted: 10,
				durationSeconds: 320,
				settledAt: 1_742_000_100,
			},
			{
				rank: 3,
				playerName: 'Cara',
				endingBankroll: 1500,
				roundsCompleted: 9,
				durationSeconds: 340,
				settledAt: 1_742_000_200,
				isCurrentUser: true,
			},
		],
		currentUser: { rank: 3, totalEligible: 200, percentile: 95.5 },
		...overrides,
	};
}

function historyFixture(
	overrides: Partial<DailyChallengeHistoryResponse> = {},
): DailyChallengeHistoryResponse {
	return {
		entries: [
			{
				periodKey: PERIOD_KEY,
				challengeRulesetVersion: 'blackjack-daily-v1',
				topEndingBankroll: 1500,
				participantCount: 42,
				userResult: {
					endingBankroll: 1200,
					roundsCompleted: 10,
					terminalReason: 'completed',
					eligible: true,
					settledAt: 1_742_001_000,
				},
			},
			{
				periodKey: '2026-03-13',
				challengeRulesetVersion: 'blackjack-daily-v1',
				topEndingBankroll: null,
				participantCount: 0,
				userResult: null,
			},
		],
		...overrides,
	};
}

function localReplayFixture(
	overrides: Partial<DailyChallengeReplayV1> = {},
): DailyChallengeReplayV1 {
	return {
		availableBankroll: 1000,
		roundsCompleted: 0,
		rounds: [],
		activeRound: null,
		activeRoundPublic: null,
		nextCommandSequence: 0,
		status: 'active',
		terminalReason: null,
		eligible: null,
		...overrides,
	};
}

function activeLocalReplayFixture(): DailyChallengeReplayV1 {
	return localReplayFixture({
		activeRoundPublic: {
			phase: 'player-turn',
			playerHands: [
				{
					cards: [
						{ rank: '10', suit: 'clubs' },
						{ rank: '9', suit: 'hearts' },
					],
					wager: 100,
					value: { value: 19, isSoft: false, isBust: false },
				},
			],
			activeHandIndex: 0,
			dealer: {
				cards: [{ rank: '6', suit: 'diamonds' }],
				value: { value: 6, isSoft: false, isBust: false },
			},
			committedWager: 100,
			availableActions: ['hit', 'stand', 'double-down', 'split'],
			outcome: null,
		},
	});
}

function completedLocalReplayFixture(): DailyChallengeReplayV1 {
	return localReplayFixture({
		availableBankroll: 1400,
		roundsCompleted: 10,
		status: 'completed',
		terminalReason: 'completed',
		eligible: true,
	});
}

function forfeitedLocalReplayFixture(): DailyChallengeReplayV1 {
	return localReplayFixture({
		availableBankroll: 900,
		roundsCompleted: 0,
		status: 'forfeited',
		terminalReason: 'forfeited',
		eligible: false,
	});
}

function mountShell({ authenticated = true }: { authenticated?: boolean } = {}): {
	root: HTMLElement;
	get: (testId: string) => HTMLElement;
} {
	document.body.replaceChildren();
	const root = document.createElement('main');
	if (authenticated) root.dataset.userId = 'user-1';
	else root.dataset.userId = 'guest';
	root.innerHTML = `
		<p data-testid="daily-challenge-close"></p>
		<div class="mode-row">
			<button data-testid="daily-challenge-mode-practice"></button>
			<button data-testid="daily-challenge-mode-ranked"></button>
			<a data-testid="daily-challenge-sign-in-cta" href="/signin" hidden></a>
		</div>
		<div data-testid="daily-challenge-practice-notices" hidden>
			<p data-testid="daily-challenge-practice-different"></p>
			<p data-testid="daily-challenge-shared-seed-notice"></p>
		</div>
		<div data-testid="daily-challenge-ranked-notices" hidden>
			<p data-testid="daily-challenge-once-warning"></p>
		</div>
		<section data-testid="daily-challenge-controls" hidden>
			<p data-testid="daily-challenge-bankroll"></p>
			<p data-testid="daily-challenge-committed-wager"></p>
			<p data-testid="daily-challenge-round-progress"></p>
			<p data-testid="daily-challenge-dealer-value"></p>
			<div data-testid="daily-challenge-dealer-hand"></div>
			<div data-testid="daily-challenge-player-hands"></div>
			<p data-testid="daily-challenge-status" role="status" aria-live="polite"></p>
			<input data-testid="daily-challenge-wager" type="number" min="10" max="1000" step="10" value="100" />
			<button data-testid="daily-challenge-start-ranked"></button>
			<button data-testid="daily-challenge-start-round"></button>
			<button data-testid="daily-challenge-action-hit"></button>
			<button data-testid="daily-challenge-action-stand"></button>
			<button data-testid="daily-challenge-action-double-down"></button>
			<button data-testid="daily-challenge-action-split"></button>
			<button data-testid="daily-challenge-forfeit"></button>
			<button data-testid="daily-challenge-forfeit-confirm" hidden></button>
			<button data-testid="daily-challenge-forfeit-cancel" hidden></button>
			<button data-testid="daily-challenge-restart-practice"></button>
			<button data-testid="daily-challenge-replay-scenario-practice"></button>
			<button data-testid="daily-challenge-replay-scenario-exact-ranked"></button>
			<section data-testid="daily-challenge-receipt" hidden>
				<p data-testid="daily-challenge-receipt-eligibility"></p>
				<p data-testid="daily-challenge-receipt-bankroll"></p>
				<p data-testid="daily-challenge-receipt-rounds"></p>
				<p data-testid="daily-challenge-rank"></p>
				<p data-testid="daily-challenge-percentile"></p>
			</section>
		</section>
		<section data-testid="daily-challenge-leaderboard">
			<ol data-testid="daily-challenge-leaderboard-rows"></ol>
			<p data-testid="daily-challenge-current-standing" hidden></p>
		</section>
		<section data-testid="daily-challenge-history">
			<ol data-testid="daily-challenge-history-rows"></ol>
		</section>
	`;
	document.body.append(root);
	return {
		root,
		get: (testId: string) => {
			const element = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
			if (!element) throw new Error(`missing test element ${testId}`);
			return element;
		},
	};
}

function createHandlers(): DailyChallengeRendererHandlers & {
	calls: Record<string, unknown[]>;
} {
	const calls: Record<string, unknown[]> = {
		onSelectMode: [],
		onStartRanked: [],
		onStartRound: [],
		onAction: [],
		onForfeit: [],
		onRestartPractice: [],
		onSelectReplayScenario: [],
	};
	return {
		calls,
		onSelectMode: mock((mode) => calls.onSelectMode.push(mode)),
		onStartRanked: mock(() => calls.onStartRanked.push(null)),
		onStartRound: mock((wager) => calls.onStartRound.push(wager)),
		onAction: mock((action) => calls.onAction.push(action)),
		onForfeit: mock(() => calls.onForfeit.push(null)),
		onRestartPractice: mock(() => calls.onRestartPractice.push(null)),
		onSelectReplayScenario: mock((scenario) => calls.onSelectReplayScenario.push(scenario)),
	};
}

function mount(overrides: { authenticated?: boolean } = {}): {
	root: HTMLElement;
	get: (testId: string) => HTMLElement;
	renderer: ReturnType<typeof createDailyChallengeRenderer>;
	handlers: ReturnType<typeof createHandlers>;
} {
	const shell = mountShell(overrides);
	const handlers = createHandlers();
	const renderer = createDailyChallengeRenderer(shell.root);
	renderer.bind(handlers);
	return { ...shell, renderer, handlers };
}

beforeEach(() => {
	document.body.replaceChildren();
});

describe('daily challenge renderer — mode selection', () => {
	test('a guest gets an available Practice mode and a Ranked sign-in CTA', () => {
		const { root, get, renderer, handlers } = mount({ authenticated: false });
		renderer.renderChallenge(challengeFixture());

		expect(root.dataset.userId).toBe('guest');
		expect(get('daily-challenge-mode-practice').hidden).toBe(false);
		expect(get('daily-challenge-mode-ranked').hidden).toBe(true);
		const cta = get('daily-challenge-sign-in-cta') as HTMLAnchorElement;
		expect(cta.hidden).toBe(false);
		expect(cta.getAttribute('href')).toBe('/signin');
		expect(get('daily-challenge-controls').hidden).toBe(false);
		expect((get('daily-challenge-start-ranked') as HTMLButtonElement).hidden).toBe(true);

		(get('daily-challenge-mode-practice') as HTMLButtonElement).click();
		expect(handlers.calls.onSelectMode).toEqual(['practice']);
	});

	test('an authenticated user gets a Ranked mode button and no sign-in CTA', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());

		expect(get('daily-challenge-mode-ranked').hidden).toBe(false);
		expect(get('daily-challenge-sign-in-cta').hidden).toBe(true);
	});

	test('entering Ranked mode surfaces the one-attempt warning', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());

		(get('daily-challenge-mode-ranked') as HTMLButtonElement).click();

		expect(handlers.calls.onSelectMode).toEqual(['ranked']);
		expect(get('daily-challenge-ranked-notices').hidden).toBe(false);
		expect(get('daily-challenge-once-warning').textContent).toContain('one ranked attempt');
	});

	test('shows the ranked entry close time derived from the challenge window', () => {
		const { get, renderer } = mount();
		const challenge = challengeFixture();
		renderer.renderChallenge(challenge);
		const expectedTime = new Date(challenge.rankedEntryClosesAt * 1000).toISOString().slice(11, 16);
		expect(get('daily-challenge-close').textContent).toBe(
			`Ranked entry closes at ${expectedTime} UTC.`,
		);
	});

	test('exact ranked replay scenario is disabled on a live challenge and enabled post-close', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());
		(get('daily-challenge-mode-practice') as HTMLButtonElement).click();

		expect(
			(get('daily-challenge-replay-scenario-exact-ranked') as HTMLButtonElement).disabled,
		).toBe(true);
		expect((get('daily-challenge-replay-scenario-practice') as HTMLButtonElement).disabled).toBe(
			false,
		);

		renderer.renderChallenge(closedChallengeFixture());
		expect(
			(get('daily-challenge-replay-scenario-exact-ranked') as HTMLButtonElement).disabled,
		).toBe(false);
	});

	test('practice scenario selection invokes the replay scenario handler', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());
		(get('daily-challenge-mode-practice') as HTMLButtonElement).click();

		(get('daily-challenge-replay-scenario-practice') as HTMLButtonElement).click();
		expect(handlers.calls.onSelectReplayScenario).toEqual(['practice-scenario']);
	});

	test('exact ranked replay scenario selection invokes the replay scenario handler', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderChallenge(closedChallengeFixture());
		(get('daily-challenge-mode-practice') as HTMLButtonElement).click();

		(get('daily-challenge-replay-scenario-exact-ranked') as HTMLButtonElement).click();
		expect(handlers.calls.onSelectReplayScenario).toEqual(['exact-ranked-scenario']);
	});
});

describe('daily challenge renderer — practice notices', () => {
	test('shows the different-scenario and shared-seed notices in Practice mode only', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());

		expect(get('daily-challenge-practice-notices').hidden).toBe(true);

		(get('daily-challenge-mode-practice') as HTMLButtonElement).click();

		expect(get('daily-challenge-practice-notices').hidden).toBe(false);
		expect(get('daily-challenge-practice-different').textContent).toBe(
			'Practice uses a different scenario from today\u2019s ranked attempt.',
		);
		expect(get('daily-challenge-shared-seed-notice').textContent).toBe(
			'Shared daily scenarios are not resistant to player-to-player spoilers.',
		);

		(get('daily-challenge-mode-ranked') as HTMLButtonElement).click();
		expect(get('daily-challenge-practice-notices').hidden).toBe(true);
	});
});

describe('daily challenge renderer — ranked attempt HUD', () => {
	test('shows available bankroll and committed wager as separate values', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());
		renderer.renderAttempt(attemptFixture());

		expect(get('daily-challenge-bankroll').textContent).toBe('$1,000');
		expect(get('daily-challenge-committed-wager').textContent).toBe('$100');
		expect(get('daily-challenge-bankroll').textContent).not.toBe(
			get('daily-challenge-committed-wager').textContent,
		);
	});

	test('shows round progress during an active round and at completion', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());
		expect(get('daily-challenge-round-progress').textContent).toBe('Round 1 of 10');

		renderer.renderAttempt(attemptFixture({ roundsCompleted: 9, activeRound: null }));
		expect(get('daily-challenge-round-progress').textContent).toBe('Round 10 of 10');

		renderer.renderAttempt(terminalAttemptFixture());
		expect(get('daily-challenge-round-progress').textContent).toBe('Round 10 of 10');
	});

	test('enables only funded actions from the server state', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());

		expect((get('daily-challenge-action-hit') as HTMLButtonElement).disabled).toBe(false);
		expect((get('daily-challenge-action-stand') as HTMLButtonElement).disabled).toBe(false);
		expect((get('daily-challenge-action-double-down') as HTMLButtonElement).disabled).toBe(true);
		expect((get('daily-challenge-action-split') as HTMLButtonElement).disabled).toBe(true);

		renderer.renderAttempt(attemptFixture({ activeRound: FULL_ACTIONS_ROUND }));
		expect((get('daily-challenge-action-double-down') as HTMLButtonElement).disabled).toBe(false);
		expect((get('daily-challenge-action-split') as HTMLButtonElement).disabled).toBe(false);
	});

	test('wager and start-round are gated while a round is active', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());

		expect((get('daily-challenge-wager') as HTMLInputElement).disabled).toBe(true);
		expect((get('daily-challenge-start-round') as HTMLButtonElement).disabled).toBe(true);
		expect((get('daily-challenge-forfeit') as HTMLButtonElement).hidden).toBe(false);

		renderer.renderAttempt(attemptFixture({ activeRound: null }));
		expect((get('daily-challenge-wager') as HTMLInputElement).disabled).toBe(false);
		expect((get('daily-challenge-start-round') as HTMLButtonElement).disabled).toBe(false);
		expect((get('daily-challenge-forfeit') as HTMLButtonElement).hidden).toBe(true);
	});

	test('forfeit requires an explicit confirmation step', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderAttempt(attemptFixture());

		expect((get('daily-challenge-forfeit-confirm') as HTMLButtonElement).hidden).toBe(true);
		(get('daily-challenge-forfeit') as HTMLButtonElement).click();
		expect(handlers.calls.onForfeit).toEqual([]);
		expect((get('daily-challenge-forfeit-confirm') as HTMLButtonElement).hidden).toBe(false);

		(get('daily-challenge-forfeit-cancel') as HTMLButtonElement).click();
		expect(handlers.calls.onForfeit).toEqual([]);
		expect((get('daily-challenge-forfeit-confirm') as HTMLButtonElement).hidden).toBe(true);

		(get('daily-challenge-forfeit') as HTMLButtonElement).click();
		(get('daily-challenge-forfeit-confirm') as HTMLButtonElement).click();
		expect(handlers.calls.onForfeit).toHaveLength(1);
	});

	test('renders the dealer and player hands through the shared presentation', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());

		expect(
			get('daily-challenge-dealer-hand').querySelectorAll(
				'[data-testid="daily-challenge-dealer-card"]',
			),
		).toHaveLength(1);
		expect(get('daily-challenge-dealer-value').textContent).toBe('7');
		expect(
			get('daily-challenge-player-hands').querySelectorAll(
				'[data-testid="daily-challenge-player-card"]',
			),
		).toHaveLength(2);
		expect(
			get('daily-challenge-player-hands').querySelectorAll(
				'[data-testid="daily-challenge-player-hand"]',
			),
		).toHaveLength(1);
		expect(get('daily-challenge-player-hands').textContent).toContain('Hand 1 · $100');
	});
});

describe('daily challenge renderer — mode routing on attempt render', () => {
	test('renderAttempt with an active attempt switches mode to ranked and notifies the page', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());
		handlers.calls.onSelectMode = [];
		renderer.renderAttempt(attemptFixture());

		expect(handlers.calls.onSelectMode).toEqual(['ranked']);
		expect(get('daily-challenge-ranked-notices').hidden).toBe(false);
	});

	test('renderAttempt with a terminal attempt switches mode to ranked', () => {
		const { renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());
		handlers.calls.onSelectMode = [];
		renderer.renderAttempt(terminalAttemptFixture());

		expect(handlers.calls.onSelectMode).toEqual(['ranked']);
	});

	test('renderAttempt with a null attempt does not switch mode', () => {
		const { renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());
		handlers.calls.onSelectMode = [];
		renderer.renderAttempt(null);

		expect(handlers.calls.onSelectMode).toEqual([]);
	});

	test('renderAttempt does not re-notify when mode is already ranked', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());
		(get('daily-challenge-mode-ranked') as HTMLButtonElement).click();
		handlers.calls.onSelectMode = [];
		renderer.renderAttempt(attemptFixture());

		expect(handlers.calls.onSelectMode).toEqual([]);
	});
});

describe('daily challenge renderer — receipt states', () => {
	test('shows the eligible receipt with rank and percentile', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());
		renderer.renderAttempt(terminalAttemptFixture());

		expect(get('daily-challenge-receipt').hidden).toBe(false);
		expect(get('daily-challenge-receipt-eligibility').textContent).toBe('Eligible for ranking');
		expect(get('daily-challenge-receipt-bankroll').textContent).toBe('$1,200');
		expect(get('daily-challenge-receipt-rounds').textContent).toBe('10 of 10 rounds');
		expect(get('daily-challenge-rank').textContent).toBe('#3');
		expect(get('daily-challenge-percentile').textContent).toBe('95.5th percentile');
	});

	test('shows the ineligible receipt for a forfeited attempt', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(
			terminalAttemptFixture({
				status: 'forfeited',
				availableBankroll: 900,
				roundsCompleted: 4,
				rank: null,
				percentile: null,
				receipt: receiptFixture({
					endingBankroll: 900,
					roundsCompleted: 4,
					eligible: false,
					terminalReason: 'forfeited',
				}),
			}),
		);

		expect(get('daily-challenge-receipt-eligibility').textContent).toBe('Not eligible for ranking');
		expect(get('daily-challenge-rank').hidden).toBe(true);
		expect(get('daily-challenge-percentile').hidden).toBe(true);
	});

	test('hides the receipt for an active attempt and for a null attempt', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());
		expect(get('daily-challenge-receipt').hidden).toBe(true);

		renderer.renderAttempt(null);
		expect(get('daily-challenge-receipt').hidden).toBe(true);
		expect(get('daily-challenge-bankroll').textContent).toBe('—');
		expect(get('daily-challenge-status').textContent).toBe('Start your ranked attempt to begin.');
	});
});

describe('daily challenge renderer — leaderboard and history', () => {
	test('renders leaderboard rows and the current standing', () => {
		const { get, renderer } = mount();
		renderer.renderLeaderboard(leaderboardFixture());

		const rows = get('daily-challenge-leaderboard-rows').querySelectorAll(
			'[data-testid="daily-challenge-leaderboard-row"]',
		);
		expect(rows).toHaveLength(3);
		expect(rows[0]?.textContent).toContain('#1');
		expect(rows[0]?.textContent).toContain('Alice');
		expect(rows[0]?.textContent).toContain('$2,000');
		expect(rows[2]?.textContent).toContain('#3');
		expect(rows[2]?.textContent).toContain('(you)');
		expect((rows[2] as HTMLElement).dataset.isCurrentUser).toBe('true');
		expect((rows[0] as HTMLElement).dataset.isCurrentUser).toBeUndefined();
		expect(get('daily-challenge-current-standing').hidden).toBe(false);
		expect(get('daily-challenge-current-standing').textContent).toContain('#3');
		expect(get('daily-challenge-current-standing').textContent).toContain('95.5%');
	});

	test('hides the standing when the current user is absent', () => {
		const { get, renderer } = mount();
		renderer.renderLeaderboard(leaderboardFixture({ currentUser: null }));
		expect(get('daily-challenge-current-standing').hidden).toBe(true);
	});

	test('renders one challenge-centric history row per day with top score, players, and user result', () => {
		const { get, renderer } = mount();
		renderer.renderHistory(historyFixture());

		const rows = get('daily-challenge-history-rows').querySelectorAll(
			'[data-testid="daily-challenge-history-row"]',
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain('2026-03-14');
		expect(rows[0]?.textContent).toContain('Top $1,500');
		expect(rows[0]?.textContent).toContain('42 players');
		expect(rows[0]?.textContent).toContain('You: $1,200');
		expect(rows[0]?.textContent).toContain('10 rounds');
		expect(rows[0]?.textContent).toContain('Completed');
		expect((rows[0] as HTMLElement).dataset.eligible).toBe('true');
		expect(rows[1]?.textContent).toContain('No scores yet');
		expect(rows[1]?.textContent).toContain('Not played');
		expect((rows[1] as HTMLElement).dataset.eligible).toBeUndefined();
	});

	test('renders each history row as a link to the daily challenge archive page', () => {
		const { get, renderer } = mount();
		renderer.renderHistory(historyFixture());

		const links = get('daily-challenge-history-rows').querySelectorAll(
			'[data-testid="daily-challenge-history-link"]',
		);
		expect(links).toHaveLength(2);
		expect((links[0] as HTMLAnchorElement).getAttribute('href')).toBe(
			`/games/daily-challenge/${PERIOD_KEY}`,
		);
		expect((links[1] as HTMLAnchorElement).getAttribute('href')).toBe(
			'/games/daily-challenge/2026-03-13',
		);
	});

	test('renders bankroll-below-minimum, forfeited, and expired terminal reason labels in history', () => {
		const { get, renderer } = mount();
		renderer.renderHistory({
			entries: [
				{
					periodKey: PERIOD_KEY,
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: 1500,
					participantCount: 42,
					userResult: {
						endingBankroll: 0,
						roundsCompleted: 5,
						terminalReason: 'bankroll-below-minimum',
						eligible: true,
						settledAt: 1_742_001_000,
					},
				},
				{
					periodKey: '2026-03-13',
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: null,
					participantCount: 0,
					userResult: {
						endingBankroll: 900,
						roundsCompleted: 0,
						terminalReason: 'forfeited',
						eligible: false,
						settledAt: 1_742_001_000,
					},
				},
				{
					periodKey: '2026-03-12',
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: null,
					participantCount: 0,
					userResult: {
						endingBankroll: 1000,
						roundsCompleted: 0,
						terminalReason: 'expired',
						eligible: false,
						settledAt: 1_742_001_000,
					},
				},
			],
		});

		const rows = get('daily-challenge-history-rows').querySelectorAll(
			'[data-testid="daily-challenge-history-row"]',
		);
		expect(rows).toHaveLength(3);
		expect(rows[0]?.textContent).toContain('Bankroll below minimum');
		expect(rows[1]?.textContent).toContain('Forfeited');
		expect(rows[2]?.textContent).toContain('Expired');
	});

	test('renders an unknown terminal reason as-is via the default switch case', () => {
		const { get, renderer } = mount();
		renderer.renderHistory({
			entries: [
				{
					periodKey: PERIOD_KEY,
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: 1500,
					participantCount: 42,
					userResult: {
						endingBankroll: 1000,
						roundsCompleted: 10,
						terminalReason: 'unknown-reason' as 'completed',
						eligible: true,
						settledAt: 1_742_001_000,
					},
				},
			],
		});

		const rows = get('daily-challenge-history-rows').querySelectorAll(
			'[data-testid="daily-challenge-history-row"]',
		);
		expect(rows[0]?.textContent).toContain('unknown-reason');
	});
});

describe('daily challenge renderer — local replay', () => {
	test('renders a null local replay as an idle practice state', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());
		renderer.renderLocalReplay(null);

		expect(get('daily-challenge-status').textContent).toBe(
			'Start practice to play the local scenario.',
		);
		expect(get('daily-challenge-bankroll').textContent).toBe('—');
		expect(get('daily-challenge-player-hands').children).toHaveLength(0);
		expect((get('daily-challenge-wager') as HTMLInputElement).disabled).toBe(false);
		expect((get('daily-challenge-start-round') as HTMLButtonElement).disabled).toBe(false);
		expect((get('daily-challenge-restart-practice') as HTMLButtonElement).hidden).toBe(false);
	});

	test('renders an active local round with hands, bankroll, and funded actions', () => {
		const { get, renderer } = mount();
		renderer.renderChallenge(challengeFixture());
		renderer.renderLocalReplay(activeLocalReplayFixture());

		expect(get('daily-challenge-bankroll').textContent).toBe('$1,000');
		expect(get('daily-challenge-committed-wager').textContent).toBe('$100');
		expect(get('daily-challenge-round-progress').textContent).toBe('Round 1 of 10');
		expect(
			get('daily-challenge-dealer-hand').querySelectorAll(
				'[data-testid="daily-challenge-dealer-card"]',
			),
		).toHaveLength(1);
		expect(
			get('daily-challenge-player-hands').querySelectorAll(
				'[data-testid="daily-challenge-player-card"]',
			),
		).toHaveLength(2);
		expect((get('daily-challenge-action-split') as HTMLButtonElement).disabled).toBe(false);
		expect((get('daily-challenge-start-round') as HTMLButtonElement).disabled).toBe(true);
		expect((get('daily-challenge-restart-practice') as HTMLButtonElement).hidden).toBe(false);
	});

	test('renders completed and forfeited local runs without any receipt semantics', () => {
		const { get, renderer } = mount();
		renderer.renderLocalReplay(completedLocalReplayFixture());
		expect(get('daily-challenge-status').textContent).toContain('Run complete');
		expect(get('daily-challenge-round-progress').textContent).toBe('Round 10 of 10');
		expect(get('daily-challenge-receipt').hidden).toBe(true);

		renderer.renderLocalReplay(forfeitedLocalReplayFixture());
		expect(get('daily-challenge-status').textContent).toBe('Run forfeited');
		expect(get('daily-challenge-receipt').hidden).toBe(true);
	});
});

describe('daily challenge renderer — keyboard, focus, and live region', () => {
	test('status is a polite live region', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());
		const status = get('daily-challenge-status');
		expect(status.getAttribute('role')).toBe('status');
		expect(status.getAttribute('aria-live')).toBe('polite');
	});

	test('focuses the first available action when a round opens', () => {
		const { get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());
		expect(document.activeElement).toBe(get('daily-challenge-action-hit'));
	});

	test('pending disables every interactive control', () => {
		const { root, get, renderer } = mount();
		renderer.renderAttempt(attemptFixture());
		renderer.setPending(true);

		for (const testId of [
			'daily-challenge-wager',
			'daily-challenge-start-ranked',
			'daily-challenge-start-round',
			'daily-challenge-action-hit',
			'daily-challenge-action-stand',
			'daily-challenge-action-double-down',
			'daily-challenge-action-split',
			'daily-challenge-forfeit',
			'daily-challenge-restart-practice',
			'daily-challenge-replay-scenario-practice',
			'daily-challenge-replay-scenario-exact-ranked',
		]) {
			expect((get(testId) as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
		}
		expect(root.dataset.pending).toBeUndefined();
	});

	test('wires the start-round and action buttons to the handlers', () => {
		const { get, renderer, handlers } = mount();
		renderer.renderChallenge(challengeFixture());
		renderer.renderLocalReplay(null);
		(get('daily-challenge-wager') as HTMLInputElement).value = '250';
		(get('daily-challenge-start-round') as HTMLButtonElement).click();
		expect(handlers.calls.onStartRound).toEqual([250]);

		renderer.renderLocalReplay(activeLocalReplayFixture());
		(get('daily-challenge-action-stand') as HTMLButtonElement).click();
		expect(handlers.calls.onAction).toEqual(['stand']);
	});
});

describe('daily challenge renderer — no wallet or reward semantics', () => {
	test('renders no balance, ranked stats, reward, or achievement elements or text', () => {
		const { root, renderer } = mount();
		renderer.renderChallenge(challengeFixture());
		renderer.renderAttempt(terminalAttemptFixture());
		renderer.renderLeaderboard(leaderboardFixture());
		renderer.renderHistory(historyFixture());
		renderer.renderLocalReplay(completedLocalReplayFixture());

		expect(
			root.querySelectorAll(
				'[data-testid*="balance"], [data-testid*="stats"], [data-testid*="reward"], [data-testid*="achievement"]',
			),
		).toHaveLength(0);
		expect(root.textContent).not.toMatch(/reward|achievement|account balance/i);
		expect(root.textContent).not.toContain('Ranked stats');
	});
});
