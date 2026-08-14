import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { BlackjackRunPublicState } from './protocol';
import { createRankedRunRenderer, type RankedRunRenderer } from './ranked-ui';

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

function activeState(): BlackjackRunPublicState {
	return {
		mode: 'ranked',
		runId: 'abcdefghijklmnopqrstuv',
		status: 'active',
		expiresAt: 1_800_000_900,
		balance: 742,
		nextSequence: 3,
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
		availableActions: ['stand', 'split'],
		outcome: null,
	};
}

function terminalState(): BlackjackRunPublicState {
	const response = activeState();
	return {
		...response,
		status: 'settled',
		balance: 942,
		nextSequence: 4,
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
	};
}

function makeRoot(): HTMLElement {
	const root = document.createElement('main');
	root.dataset.initialBalance = '1000';
	root.innerHTML = `
		<span data-chip-balance></span>
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
		<section id="ranked-result" data-testid="ranked-result" hidden>
			<span id="ranked-result-outcome" data-testid="ranked-result-outcome"></span>
			<span id="ranked-result-wager" data-testid="ranked-result-wager"></span>
			<span id="ranked-result-payout" data-testid="ranked-result-payout"></span>
			<span id="ranked-result-net" data-testid="ranked-result-net"></span>
			<span id="ranked-result-balance" data-testid="ranked-result-balance"></span>
		</section>
	`;
	document.body.appendChild(root);
	return root;
}

describe('ranked run renderer', () => {
	let root: HTMLElement;
	let renderer: RankedRunRenderer;

	beforeEach(() => {
		root = makeRoot();
		renderer = createRankedRunRenderer(root);
	});

	afterEach(() => {
		root.remove();
	});

	test('renders only the server-projected dealer card with no hidden-hole DOM node', () => {
		renderer.render(activeState());

		const dealerCards = root.querySelectorAll('[data-testid="ranked-dealer-card"]');
		expect(dealerCards).toHaveLength(1);
		expect(dealerCards[0]?.textContent).toContain('7');
		expect(root.querySelector('[data-ranked-hole-card]')).toBeNull();
		expect(root.querySelector('[aria-label*="face down" i]')).toBeNull();
	});

	test('enables only server-provided actions and disables every control while pending', () => {
		renderer.render(activeState());

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
		renderer.render(activeState());

		const values = Array.from(
			root.querySelectorAll<HTMLElement>('[data-testid="ranked-player-value"]'),
		).map((element) => element.textContent);
		expect(values).toEqual(['Soft 17', 'Bust 23']);
		expect(root.querySelector('[data-testid="ranked-dealer-value"]')?.textContent).toBe('7');
	});

	test('replaces balance, committed wager, and countdown from authoritative values', () => {
		renderer.render(activeState());
		renderer.renderCountdown(65);

		expect(root.querySelector('[data-testid="ranked-balance"]')?.textContent).toBe('$742');
		expect(root.querySelector('[data-testid="ranked-committed-wager"]')?.textContent).toBe('$200');
		expect(root.querySelector('[data-testid="ranked-countdown"]')?.textContent).toBe('1:05');
	});

	test('reflects the server account balance after an initial/additional stake debit', () => {
		renderer.render(activeState());

		// In-table balance after a stake debit.
		expect(root.querySelector('[data-testid="ranked-balance"]')?.textContent).toBe('$742');
		// Shared header pill stays in sync ("N chips" format).
		expect(root.querySelector<HTMLElement>('[data-chip-balance]')?.textContent).toBe('742 chips');
	});

	test('terminal Result shows outcome, committed wager, payout/net, and final balance', () => {
		renderer.render(terminalState());

		expect(root.querySelector<HTMLElement>('[data-testid="ranked-result"]')?.hidden).toBe(false);
		expect(root.querySelector('[data-testid="ranked-result-outcome"]')?.textContent).toBe('Win');
		expect(root.querySelector('[data-testid="ranked-result-wager"]')?.textContent).toBe('$200');
		expect(root.querySelector('[data-testid="ranked-result-payout"]')?.textContent).toBe('$300');
		expect(root.querySelector('[data-testid="ranked-result-net"]')?.textContent).toBe('+$100');
		expect(root.querySelector('[data-testid="ranked-result-balance"]')?.textContent).toBe('$942');
		expect(root.querySelector('[data-testid="ranked-status"]')?.textContent).toBe(
			'win · run settled',
		);
		expect(root.querySelector('[data-testid="ranked-countdown"]')?.textContent).toBe('—');
		// Terminal releases the start control so a second run can begin.
		expect(root.querySelector<HTMLButtonElement>('[data-testid="ranked-start"]')?.disabled).toBe(
			false,
		);
		expect(root.querySelector<HTMLButtonElement>('[data-ranked-action="hit"]')?.disabled).toBe(
			true,
		);
	});

	test('expired terminal renders the forfeit status and result panel', () => {
		renderer.render({ ...terminalState(), status: 'expired', balance: 700 });

		expect(root.querySelector('[data-testid="ranked-status"]')?.textContent).toBe(
			'Run expired · wager forfeited',
		);
		expect(root.querySelector<HTMLElement>('[data-testid="ranked-result"]')?.hidden).toBe(false);
		expect(root.querySelector('[data-testid="ranked-result-balance"]')?.textContent).toBe('$700');
	});

	test('active state hides the result panel and keeps the countdown live', () => {
		renderer.render(activeState());

		expect(root.querySelector<HTMLElement>('[data-testid="ranked-result"]')?.hidden).toBe(true);
		expect(root.querySelector('[data-testid="ranked-status"]')?.textContent).toBe(
			'Your move · hand 1 of 2',
		);
	});

	test('binds start and action controls without introducing local game decisions', () => {
		const starts: number[] = [];
		const actions: string[] = [];
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

	test('rejects a wager outside the 10-1000 bounds without calling onStart', () => {
		const starts: number[] = [];
		renderer.bind({
			onStart: (wager) => {
				starts.push(wager);
			},
			onAction: () => {},
		});

		const input = root.querySelector<HTMLInputElement>('[data-testid="ranked-wager"]')!;
		input.value = '5';
		root.querySelector<HTMLButtonElement>('[data-testid="ranked-start"]')?.click();
		input.value = '1500';
		root.querySelector<HTMLButtonElement>('[data-testid="ranked-start"]')?.click();
		input.value = '10.5';
		root.querySelector<HTMLButtonElement>('[data-testid="ranked-start"]')?.click();

		expect(starts).toEqual([]);
		expect(root.querySelector('[data-testid="ranked-status"]')?.textContent).toBe(
			'Wager must be a whole number between 10 and 1,000.',
		);

		input.value = '10';
		root.querySelector<HTMLButtonElement>('[data-testid="ranked-start"]')?.click();
		expect(starts).toEqual([10]);
	});

	test('render(null) falls back to data-initial-balance and clears hands and status', () => {
		renderer.render(activeState());
		renderer.render(null);

		expect(root.querySelector('[data-testid="ranked-balance"]')?.textContent).toBe('$1,000');
		expect(root.querySelector('[data-testid="ranked-committed-wager"]')?.textContent).toBe('$0');
		expect(root.querySelector('[data-testid="ranked-status"]')?.textContent).toBe(
			'Choose a wager to begin a ranked run.',
		);
		expect(root.querySelectorAll('[data-testid="ranked-dealer-card"]')).toHaveLength(0);
		expect(root.querySelectorAll('[data-testid="ranked-player-hand"]')).toHaveLength(0);
		expect(root.querySelector<HTMLElement>('[data-testid="ranked-result"]')?.hidden).toBe(true);
		expect(root.querySelector('[data-testid="ranked-dealer-value"]')?.textContent).toBe('—');
		expect(root.querySelector('[data-testid="ranked-countdown"]')?.textContent).toBe('—');
	});

	test('renderError displays the error message in the status element', () => {
		renderer.render(activeState());
		renderer.renderError('Something went wrong');

		expect(root.querySelector('[data-testid="ranked-status"]')?.textContent).toBe(
			'Something went wrong',
		);
	});
});
