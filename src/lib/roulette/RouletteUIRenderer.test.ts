import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import {
	installMockDocument,
	installMockLocalStorage,
	MockElement,
	attachToBody,
	makeChipSelect,
	type MockDocumentSetup,
} from './test-dom-mock';
import { RED_NUMBERS, WHEEL_ORDER } from './constants';
import type { BetResult, RouletteBet, RouletteGameState, SpinResult } from './types';

const RENDERER_IDS = [
	'roulette-wheel',
	'wheel-result',
	'chip-balance',
	'total-bet',
	'active-bets',
	'round-history',
	'spin-button',
	'clear-bets-button',
	'new-round-button',
	'game-phase',
];

function makeState(overrides: Partial<RouletteGameState> = {}): RouletteGameState {
	return {
		phase: 'betting',
		activeBets: [],
		chipBalance: 1000,
		selectedChipAmount: 25,
		lastSpin: null,
		roundHistory: [],
		...overrides,
	};
}

function makeBet(type: RouletteBet['type'], amount = 10, target?: number): RouletteBet {
	return { id: 'b1', type, amount, ...(target !== undefined ? { target } : {}) };
}

function makeSpin(winningNumber: number, netDelta = 0, results: BetResult[] = []): SpinResult {
	return {
		winningNumber,
		bets: [],
		totalBet: 10,
		totalPayout: 10 + netDelta,
		netDelta,
		results,
		timestamp: Date.now(),
		syncId: 'sync-1',
	};
}

let setup: MockDocumentSetup;

beforeEach(() => {
	installMockLocalStorage();
	setup = installMockDocument(RENDERER_IDS);
});

afterEach(() => {
	// Reset the wheel rotation accumulator between tests by re-installing.
	installMockDocument(RENDERER_IDS);
});

describe('RouletteUIRenderer — update', () => {
	it('renders balance and total bet with locale formatting', () => {
		const renderer = new RouletteUIRenderer();
		const bet = makeBet('red', 1250);
		renderer.update(makeState({ chipBalance: 12345, activeBets: [bet] }));

		expect(setup.elements['chip-balance'].textContent).toBe('$12,345');
		expect(setup.elements['total-bet'].textContent).toBe('$1,250');
	});

	it('enables spin only when bets exist and phase is betting', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ phase: 'betting', activeBets: [] }));
		expect(setup.elements['spin-button'].disabled).toBe(true);
		expect(setup.elements['clear-bets-button'].disabled).toBe(true);

		renderer.update(makeState({ phase: 'betting', activeBets: [makeBet('red')] }));
		expect(setup.elements['spin-button'].disabled).toBe(false);
		expect(setup.elements['clear-bets-button'].disabled).toBe(false);
	});

	it('disables spin and clear during spinning phase', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ phase: 'spinning', activeBets: [makeBet('red')] }));
		expect(setup.elements['spin-button'].disabled).toBe(true);
		expect(setup.elements['clear-bets-button'].disabled).toBe(true);
	});

	it('shows new-round and hides spin in settled phase, reverses otherwise', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ phase: 'settled' }));
		expect(setup.elements['new-round-button'].hidden).toBe(false);
		expect(setup.elements['spin-button'].hidden).toBe(true);

		renderer.update(makeState({ phase: 'betting' }));
		expect(setup.elements['new-round-button'].hidden).toBe(true);
		expect(setup.elements['spin-button'].hidden).toBe(false);
	});

	it('renders phase label for each phase', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ phase: 'betting' }));
		expect(setup.elements['game-phase'].textContent).toBe('Place Your Bets');
		renderer.update(makeState({ phase: 'spinning' }));
		expect(setup.elements['game-phase'].textContent).toBe('No More Bets');
		renderer.update(makeState({ phase: 'settled' }));
		expect(setup.elements['game-phase'].textContent).toBe('Round Complete');
	});
});

describe('RouletteUIRenderer — renderActiveBets', () => {
	it('shows placeholder when no bets', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ activeBets: [] }));
		const list = setup.elements['active-bets'];
		expect(list.children).toHaveLength(1);
		expect(list.children[0].textContent).toBe('No bets placed');
	});

	it('renders one entry per bet with label and amount', () => {
		const renderer = new RouletteUIRenderer();
		const bets = [
			{ id: 'a', type: 'red' as const, amount: 50 },
			{ id: 'b', type: 'straight' as const, amount: 10, target: 17 },
		];
		renderer.update(makeState({ activeBets: bets }));
		const list = setup.elements['active-bets'];
		expect(list.children).toHaveLength(2);
		expect(list.children[0].id).toBe('active-bet-a');
		// First child span = label, second = amount
		expect(list.children[0].children[0].textContent).toBe('Red');
		expect(list.children[0].children[1].textContent).toBe('$50');
		expect(list.children[1].children[0].textContent).toBe('Straight 17');
	});
});

describe('RouletteUIRenderer — renderRoundHistory', () => {
	it('shows placeholder when history empty', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ roundHistory: [] }));
		const list = setup.elements['round-history'];
		expect(list.children).toHaveLength(1);
		expect(list.children[0].textContent).toBe('No rounds yet');
	});

	it('renders a colored badge per history entry and caps at 10', () => {
		const renderer = new RouletteUIRenderer();
		const history: SpinResult[] = [];
		for (let i = 0; i < 12; i++) history.push(makeSpin(i));
		renderer.update(makeState({ roundHistory: history }));
		const list = setup.elements['round-history'];
		expect(list.children).toHaveLength(10);
		// First rendered entry is history[2] (slice(0,10) of 12 → indices 0..9,
		// but we assert the badge text matches the winning number).
		expect(list.children[0].textContent).toBe('0');
	});

	it('uses round-green for 0, round-red for red numbers, round-black otherwise', () => {
		const renderer = new RouletteUIRenderer();
		renderer.update(makeState({ roundHistory: [makeSpin(0), makeSpin(1), makeSpin(2)] }));
		const list = setup.elements['round-history'];
		expect(list.children[0].attributes.class).toContain('round-green');
		expect(list.children[1].attributes.class).toContain('round-red');
		expect(list.children[2].attributes.class).toContain('round-black');
		expect(RED_NUMBERS.has(1)).toBe(true);
		expect(RED_NUMBERS.has(2)).toBe(false);
	});
});

describe('RouletteUIRenderer — animateWheel', () => {
	it('sets a rotate transform and accumulates rotation across calls', () => {
		const renderer = new RouletteUIRenderer();
		const wheel = setup.elements['roulette-wheel'];
		renderer.animateWheel(0);
		const firstRotation = wheel.style.transform;
		expect(firstRotation.startsWith('rotate(')).toBe(true);

		renderer.animateWheel(0);
		// Second call must rotate further (5 full turns + delta each time).
		expect(wheel.style.transform).not.toBe(firstRotation);
	});

	it('positions the wheel so the winning pocket lands at the top', () => {
		const renderer = new RouletteUIRenderer();
		const wheel = setup.elements['roulette-wheel'];
		const target = 17;
		const pocketIndex = (WHEEL_ORDER as readonly number[]).indexOf(target);
		renderer.animateWheel(target);
		// First call: rotation = 5*360 + forwardDelta, where forwardDelta
		// brings pocketIndex to angle 0. Extract the degrees modulo 360.
		const match = wheel.style.transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
		expect(match).not.toBeNull();
		const degrees = Number(match![1]);
		const SEGMENT = 360 / 37;
		// After removing full turns, the residual should point pocketIndex to 0.
		const residual = ((degrees % 360) + 360) % 360;
		const expected = ((-(pocketIndex * SEGMENT) % 360) + 360) % 360;
		expect(Math.abs(residual - expected)).toBeLessThan(0.001);
	});
});

describe('RouletteUIRenderer — showResult / clearResult', () => {
	it('renders winning number + color and aria-label', () => {
		const renderer = new RouletteUIRenderer();
		renderer.showResult(makeSpin(0, 0, []));
		expect(setup.elements['wheel-result'].textContent).toBe('0 Green');
		expect(setup.elements['wheel-result'].attributes['aria-label']).toBe('Winning number: 0 Green');

		renderer.showResult(makeSpin(1, 0, []));
		expect(setup.elements['wheel-result'].textContent).toBe('1 Red');
		renderer.showResult(makeSpin(2, 0, []));
		expect(setup.elements['wheel-result'].textContent).toBe('2 Black');
	});

	it('renders positive net delta in jade and negative in oxblood', () => {
		const renderer = new RouletteUIRenderer();
		setup.registerElement('net-delta');
		renderer.showResult(makeSpin(1, 350, []));
		const netEl = setup.elements['net-delta'];
		expect(netEl.textContent).toBe('+350');
		expect(netEl.style.color).toBe('var(--deco-jade)');

		renderer.showResult(makeSpin(1, -100, []));
		expect(netEl.textContent).toBe('-100');
		expect(netEl.style.color).toBe('var(--deco-oxblood-bright)');
	});

	it('renders zero net delta in muted color', () => {
		const renderer = new RouletteUIRenderer();
		setup.registerElement('net-delta');
		renderer.showResult(makeSpin(1, 0, []));
		const netEl = setup.elements['net-delta'];
		expect(netEl.textContent).toBe('0');
		expect(netEl.style.color).toBe('var(--deco-muted)');
	});

	it('renders bet result rows for wins and losses', () => {
		const renderer = new RouletteUIRenderer();
		setup.registerElement('bet-results');
		const results: BetResult[] = [
			{ bet: makeBet('red', 50), won: true, payout: 100 },
			{ bet: makeBet('black', 30), won: false, payout: 0 },
		];
		renderer.showResult(makeSpin(1, 70, results));
		const el = setup.elements['bet-results'];
		expect(el.children).toHaveLength(2);
		// Win row
		expect(el.children[0].children[1].textContent).toBe('+100');
		expect(el.children[0].children[1].style.color).toBe('var(--deco-jade)');
		// Loss row
		expect(el.children[1].children[1].textContent).toBe('-30');
		expect(el.children[1].children[1].style.color).toBe('var(--deco-oxblood-bright)');
		expect(el.children[1].children[0].classList.contains('opacity-60')).toBe(true);
	});

	it('clearResult wipes result text, aria-label, net-delta, and bet-results', () => {
		const renderer = new RouletteUIRenderer();
		setup.registerElement('net-delta');
		setup.registerElement('bet-results');
		renderer.showResult(makeSpin(1, 50, [{ bet: makeBet('red', 10), won: true, payout: 20 }]));
		renderer.clearResult();
		expect(setup.elements['wheel-result'].textContent).toBe('');
		expect('aria-label' in setup.elements['wheel-result'].attributes).toBe(false);
		expect(setup.elements['net-delta'].textContent).toBe('');
		expect(setup.elements['net-delta'].style.color).toBe('');
		expect(setup.elements['bet-results'].children).toHaveLength(0);
	});

	it('clearResult is a no-op when net-delta/bet-results elements are absent', () => {
		const renderer = new RouletteUIRenderer();
		expect(() => renderer.clearResult()).not.toThrow();
		expect(setup.elements['wheel-result'].textContent).toBe('');
	});
});

describe('RouletteUIRenderer — chip selection', () => {
	it('getSelectedChipAmount returns the selected chip amount', () => {
		const renderer = new RouletteUIRenderer();
		makeChipSelect(5);
		makeChipSelect(25, true);
		makeChipSelect(100);
		expect(renderer.getSelectedChipAmount()).toBe(25);
	});

	it('getSelectedChipAmount defaults to 5 when no chip is selected', () => {
		const renderer = new RouletteUIRenderer();
		makeChipSelect(5);
		makeChipSelect(25);
		expect(renderer.getSelectedChipAmount()).toBe(5);
	});

	it('setSelectedChip toggles the selected class and aria-pressed', () => {
		const renderer = new RouletteUIRenderer();
		const c5 = makeChipSelect(5);
		const c25 = makeChipSelect(25);
		const c100 = makeChipSelect(100);
		renderer.setSelectedChip(25);
		expect(c25.classList.contains('selected')).toBe(true);
		expect(c25.attributes['aria-pressed']).toBe('true');
		expect(c5.classList.contains('selected')).toBe(false);
		expect(c5.attributes['aria-pressed']).toBe('false');
		expect(c100.attributes['aria-pressed']).toBe('false');
	});
});

describe('RouletteUIRenderer — betLabel (full coverage)', () => {
	function labelFor(type: RouletteBet['type'], target?: number): string {
		installMockDocument(RENDERER_IDS);
		const renderer = new RouletteUIRenderer() as unknown as {
			betLabel: (bet: RouletteBet) => string;
		};
		return renderer.betLabel(makeBet(type, 10, target));
	}

	it('labels each outside bet type', () => {
		expect(labelFor('straight', 17)).toBe('Straight 17');
		expect(labelFor('red')).toBe('Red');
		expect(labelFor('black')).toBe('Black');
		expect(labelFor('odd')).toBe('Odd');
		expect(labelFor('even')).toBe('Even');
		expect(labelFor('low')).toBe('1–18');
		expect(labelFor('high')).toBe('19–36');
	});

	it('labels dozen bets by target index', () => {
		expect(labelFor('dozen', 0)).toBe('1st 12');
		expect(labelFor('dozen', 1)).toBe('2nd 12');
		expect(labelFor('dozen', 2)).toBe('3rd 12');
	});

	it('labels column bets by target index (0→Col3, 1→Col2, 2→Col1)', () => {
		expect(labelFor('column', 0)).toBe('Column 3');
		expect(labelFor('column', 1)).toBe('Column 2');
		expect(labelFor('column', 2)).toBe('Column 1');
	});
});
