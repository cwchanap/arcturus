import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { RankedBlackjackResponseV1 } from './client';
import { createRankedBlackjackRenderer } from './ui';

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

function activeResponse(): RankedBlackjackResponseV1 {
	return {
		sessionId: 'abcdefghijklmnopqrstuv',
		status: 'active',
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		seedCommitment: 'seed-commitment',
		expiresAt: 1_800_000_900,
		nextSequence: 3,
		balance: 742,
		state: {
			phase: 'player-turn',
			playerHands: [
				{
					cards: [
						{ rank: 'A', suit: 'clubs' },
						{ rank: '9', suit: 'hearts' },
					],
					wager: 100,
					value: { value: 17, isSoft: true, isBust: false },
				},
				{
					cards: [
						{ rank: 'K', suit: 'spades' },
						{ rank: 'Q', suit: 'diamonds' },
					],
					wager: 100,
					value: { value: 23, isSoft: false, isBust: true },
				},
			],
			activeHandIndex: 0,
			dealer: {
				cards: [{ rank: '7', suit: 'spades' }],
				value: { value: 7, isSoft: false, isBust: false },
			},
			committedWager: 200,
			nextSequence: 3,
			availableActions: ['stand', 'split'],
			outcome: null,
		},
		receipt: null,
	};
}

function terminalResponse(): RankedBlackjackResponseV1 {
	const response = activeResponse();
	return {
		...response,
		status: 'settled',
		balance: 942,
		state: {
			...response.state,
			phase: 'complete',
			dealer: {
				cards: [
					{ rank: '7', suit: 'spades' },
					{ rank: '10', suit: 'hearts' },
				],
				value: { value: 17, isSoft: false, isBust: false },
			},
			availableActions: [],
			outcome: {
				result: 'win',
				hands: [
					{ handIndex: 0, result: 'win', wager: 100, payout: 200 },
					{ handIndex: 1, result: 'push', wager: 100, payout: 100 },
				],
				committedWager: 200,
				payout: 300,
				gameNetDelta: 100,
			},
		},
		receipt: {
			sessionId: 'abcdefghijklmnopqrstuv',
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			seedCommitment: 'seed-commitment',
			configHash: 'config-hash',
			actionLogHash: 'action-log-hash',
			outcome: {
				result: 'win',
				hands: [
					{ handIndex: 0, result: 'win', wager: 100, payout: 200 },
					{ handIndex: 1, result: 'push', wager: 100, payout: 100 },
				],
				committedWager: 200,
				payout: 300,
				gameNetDelta: 100,
			},
			initialWager: 100,
			committedWager: 200,
			payout: 300,
			gameNetDelta: 100,
			rewardDelta: 100,
			balanceAfter: 942,
			statsEffects: {
				sessionsPlayed: 1,
				totalWins: 1,
				totalLosses: 0,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 100,
				biggestWin: 100,
			},
			achievementEffects: ['ranked_debut'],
			rewardEffects: [{ rewardId: 'ranked_debut_100', chipAmount: 100 }],
			settledAt: 1_800_000_100,
			receiptHash: 'receipt-hash-abc',
		},
	};
}

function makeRoot(): HTMLElement {
	const root = document.createElement('main');
	root.dataset.initialBalance = '1000';
	root.innerHTML = `
		<input id="ranked-wager" data-testid="ranked-wager" type="number" value="100">
		<button id="ranked-start" data-testid="ranked-start">Start</button>
		<span id="ranked-countdown" data-testid="ranked-countdown"></span>
		<div id="ranked-dealer-hand" data-testid="ranked-dealer-hand"></div>
		<span id="ranked-dealer-value" data-testid="ranked-dealer-value"></span>
		<div id="ranked-player-hands" data-testid="ranked-player-hands"></div>
		<span id="ranked-status" data-testid="ranked-status"></span>
		<span id="ranked-committed-wager" data-testid="ranked-committed-wager"></span>
		<span id="ranked-balance" data-testid="ranked-balance"></span>
		<div id="ranked-actions" data-testid="ranked-actions">
			<button data-testid="ranked-action-hit" data-ranked-action="hit">Hit</button>
			<button data-testid="ranked-action-stand" data-ranked-action="stand">Stand</button>
			<button data-testid="ranked-action-double-down" data-ranked-action="double-down">Double</button>
			<button data-testid="ranked-action-split" data-ranked-action="split">Split</button>
		</div>
		<section id="ranked-receipt" data-testid="ranked-receipt" hidden>
			<span id="ranked-receipt-id" data-testid="ranked-receipt-id"></span>
			<span id="ranked-receipt-hash" data-testid="ranked-receipt-hash"></span>
			<span id="ranked-stats" data-testid="ranked-stats"></span>
		</section>
		<div id="ranked-achievement-toast" data-testid="ranked-achievement-toast"
			class="opacity-0 pointer-events-none translate-y-4">
			<span id="ranked-achievement-icon"></span>
			<span id="ranked-achievement-name"></span>
		</div>
	`;
	document.body.appendChild(root);
	return root;
}

describe('ranked Blackjack renderer', () => {
	let root: HTMLElement;

	beforeEach(() => {
		root = makeRoot();
	});

	afterEach(() => {
		root.remove();
	});

	test('renders only the server-projected dealer cards with no hidden-hole DOM node', () => {
		const renderer = createRankedBlackjackRenderer(root);

		renderer.render(activeResponse());

		const dealerCards = root.querySelectorAll('[data-testid="ranked-dealer-card"]');
		expect(dealerCards).toHaveLength(1);
		expect(dealerCards[0]?.textContent).toContain('7');
		expect(root.querySelector('[data-ranked-hole-card]')).toBeNull();
		expect(root.querySelector('[aria-label*="face down" i]')).toBeNull();
	});

	test('enables only server-provided actions and disables every control while pending', () => {
		const renderer = createRankedBlackjackRenderer(root);
		renderer.render(activeResponse());

		expect(root.querySelector<HTMLButtonElement>('[data-ranked-action="hit"]')?.disabled).toBe(
			true,
		);
		expect(root.querySelector<HTMLButtonElement>('[data-ranked-action="stand"]')?.disabled).toBe(
			false,
		);
		expect(
			root.querySelector<HTMLButtonElement>('[data-ranked-action="double-down"]')?.disabled,
		).toBe(true);
		expect(root.querySelector<HTMLButtonElement>('[data-ranked-action="split"]')?.disabled).toBe(
			false,
		);

		renderer.setPending(true);

		expect(
			Array.from(root.querySelectorAll<HTMLButtonElement>('button')).every(
				(button) => button.disabled,
			),
		).toBe(true);
		expect(root.querySelector<HTMLInputElement>('[data-testid="ranked-wager"]')?.disabled).toBe(
			true,
		);
	});

	test('renders structured hand values instead of recomputing them from cards', () => {
		const renderer = createRankedBlackjackRenderer(root);

		renderer.render(activeResponse());

		const values = Array.from(
			root.querySelectorAll<HTMLElement>('[data-testid="ranked-player-value"]'),
		).map((element) => element.textContent);
		expect(values).toEqual(['Soft 17', 'Bust 23']);
		expect(root.querySelector('[data-testid="ranked-dealer-value"]')?.textContent).toBe('7');
	});

	test('replaces balance, committed wager, and countdown from authoritative values', () => {
		const renderer = createRankedBlackjackRenderer(root);

		renderer.render(activeResponse());
		renderer.renderCountdown(65);

		expect(root.querySelector('[data-testid="ranked-balance"]')?.textContent).toBe('$742');
		expect(root.querySelector('[data-testid="ranked-committed-wager"]')?.textContent).toBe('$200');
		expect(root.querySelector('[data-testid="ranked-countdown"]')?.textContent).toBe('1:05');
	});

	test('renders terminal receipt and stats and resolves achievement IDs through the catalog', () => {
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = (() => 1) as typeof setTimeout;
		try {
			const renderer = createRankedBlackjackRenderer(root);

			renderer.render(terminalResponse());

			expect(root.querySelector<HTMLElement>('[data-testid="ranked-receipt"]')?.hidden).toBe(false);
			expect(root.querySelector('[data-testid="ranked-receipt-id"]')?.textContent).toBe(
				'abcdefghijklmnopqrstuv',
			);
			expect(root.querySelector('[data-testid="ranked-receipt-hash"]')?.textContent).toBe(
				'receipt-hash-abc',
			);
			expect(root.querySelector('[data-testid="ranked-stats"]')?.textContent).toBe(
				'1 played · 1 win · +$100 net · $100 biggest win',
			);
			expect(root.querySelector('#ranked-achievement-name')?.textContent).toBe('Ranked Debut');
			expect(root.querySelector('#ranked-achievement-icon')?.textContent).toBe('🎖️');
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	test('binds start and action controls without introducing local game decisions', () => {
		const starts: number[] = [];
		const actions: string[] = [];
		const renderer = createRankedBlackjackRenderer(root);
		renderer.bind({
			onStart: (wager) => {
				starts.push(wager);
			},
			onAction: (action) => {
				actions.push(action);
			},
		});

		root.querySelector<HTMLButtonElement>('[data-testid="ranked-start"]')?.click();
		root.querySelector<HTMLButtonElement>('[data-ranked-action="split"]')?.click();

		expect(starts).toEqual([100]);
		expect(actions).toEqual(['split']);
	});
});
