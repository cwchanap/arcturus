import { describe, test, expect, mock, beforeAll, beforeEach } from 'bun:test';

// Mock rollDice so we control the outcome
import type { DiceRoll } from './types';

let mockRoll: DiceRoll | null = null;
let CrapsGame: typeof import('./CrapsGame').CrapsGame;

mock.module('./diceRoller', () => ({
	rollDie: () => 1,
	rollDice: () => mockRoll ?? { die1: 3, die2: 4, total: 7 },
	createRoll: (d1: number, d2: number) => ({
		die1: d1 as DiceRoll['die1'],
		die2: d2 as DiceRoll['die2'],
		total: (d1 + d2) as DiceRoll['total'],
	}),
}));

beforeAll(async () => {
	({ CrapsGame } = await import('./CrapsGame'));
});

beforeEach(() => {
	mockRoll = null;
});

function makeGame(balance = 1000) {
	return new CrapsGame({ initialBalance: balance, settings: { minBet: 5, maxBet: 500 } });
}

function setRoll(die1: number, die2: number) {
	mockRoll = {
		die1: die1 as DiceRoll['die1'],
		die2: die2 as DiceRoll['die2'],
		total: (die1 + die2) as DiceRoll['total'],
	};
}

describe('CrapsGame — bet placement', () => {
	test('can place Pass Line during come-out', () => {
		const g = makeGame();
		const r = g.placeBet('passLine', 50);
		expect(r.success).toBe(true);
		expect(g.getBalance()).toBe(950);
	});

	test('cannot place Come bet during come-out', () => {
		const g = makeGame();
		const r = g.placeBet('come', 50);
		expect(r.success).toBe(false);
	});

	test('cannot place Pass Line during point phase', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // 6 — establishes point
		g.roll();
		const r = g.placeBet('passLine', 50);
		expect(r.success).toBe(false);
	});

	test('can place Come bet during point phase', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // establishes point 6
		g.roll();
		const r = g.placeBet('come', 50);
		expect(r.success).toBe(true);
	});

	test('rejects bet below min', () => {
		const g = makeGame();
		const r = g.placeBet('passLine', 3);
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/Minimum/i);
	});

	test('rejects bet above max', () => {
		const g = makeGame();
		const r = g.placeBet('passLine', 1000);
		expect(r.success).toBe(false);
	});

	test('rejects when insufficient balance', () => {
		const g = makeGame(10);
		const r = g.placeBet('passLine', 50);
		expect(r.success).toBe(false);
	});
});

describe('CrapsGame — pass line odds', () => {
	test('can add pass line odds during point phase', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 3); // point = 6
		g.roll();
		const r = g.placeBet('passLineOdds', 100);
		expect(r.success).toBe(true);
		expect(g.getBalance()).toBe(800); // 1000 - 100 (passLine) - 100 (odds)
	});

	test('cannot add odds exceeding max multiplier', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 3);
		g.roll();
		// 2x max odds = 200, try to add 201
		const r = g.placeBet('passLineOdds', 201);
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/Max odds/i);
	});

	test('rejects odds without a pass line bet', () => {
		const g = makeGame();
		g.placeBet('dontPass', 100);
		setRoll(3, 3); // establish point while keeping no Pass Line bet active
		g.roll();
		const r = g.placeBet('passLineOdds', 100);
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/No Pass Line/i);
	});
});

describe('CrapsGame — rolling and phase transitions', () => {
	test('cannot roll without any bets', () => {
		const g = makeGame();
		expect(g.roll()).toBeNull();
	});

	test('winning place bet remains active for future rolls', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // establish point 6
		g.roll();

		g.placeBet('place8', 60);
		setRoll(4, 4); // place8 wins
		g.roll();

		const state = g.getState();
		expect(state.activeBets.some((b) => b.type === 'place8')).toBe(true);
		expect(g.getBalance()).toBe(1020);
	});

	test('natural 7 on come-out keeps come-out phase and wins pass line', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 4); // 7 — natural
		const result = g.roll();
		expect(result?.phase).toBe('come-out');
		expect(result?.point).toBeNull();
		expect(g.getBalance()).toBe(1100); // 900 (after bet) + 100 returned + 100 profit
	});

	test('point number establishes point phase', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 3); // 6
		const result = g.roll();
		expect(result?.phase).toBe('point');
		expect(result?.point).toBe(6);
	});

	test('rolling point during point phase wins and resets to come-out', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 3); // point = 6
		g.roll();
		setRoll(3, 3); // roll 6 again — point made
		const result = g.roll();
		expect(result?.phase).toBe('come-out');
		expect(result?.point).toBeNull();
		// Should have won: balance was 900 after bet placed, now 900 + 100 (return) + 100 (win) = 1100
		expect(g.getBalance()).toBe(1100);
	});

	test('seven-out resets to come-out and loses pass line', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 3); // point = 6
		g.roll();
		setRoll(3, 4); // seven out
		const result = g.roll();
		expect(result?.phase).toBe('come-out');
		expect(result?.point).toBeNull();
		// Bet was already deducted; no refund on lose
		expect(g.getBalance()).toBe(900);
	});

	test('come bet establishes come point', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // point = 6
		g.roll();
		g.placeBet('come', 50);
		setRoll(2, 2); // 4 — come point established
		g.roll();
		const state = g.getState();
		const comeBet = state.activeBets.find((b) => b.type === 'come');
		expect(comeBet?.point).toBe(4);
	});
});

describe('CrapsGame — balance and at-risk tracking', () => {
	test('getTotalAtRisk includes all active bets', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		g.placeBet('field', 50);
		expect(g.getTotalAtRisk()).toBe(150);
	});

	test('getTotalAtRisk includes odds', () => {
		const g = makeGame();
		g.placeBet('passLine', 100);
		setRoll(3, 3); // point = 6
		g.roll();
		g.placeBet('passLineOdds', 200);
		expect(g.getTotalAtRisk()).toBe(300);
	});
});

describe('CrapsGame — removing bets', () => {
	test('can remove a free-standing place bet', () => {
		const g = makeGame();
		g.placeBet('passLine', 50); // need a bet to roll
		setRoll(3, 3); // point 6
		g.roll();
		const r = g.placeBet('place8', 60);
		const id = r.bet!.id;
		const remove = g.removeBet(id);
		expect(remove.success).toBe(true);
		// balance: 1000 - 50 (passLine) - 60 (place8) + 60 (returned) = 950
		expect(g.getBalance()).toBe(950);
	});

	test('cannot remove pass line after point is established', () => {
		const g = makeGame();
		const r = g.placeBet('passLine', 100);
		const id = r.bet!.id;
		setRoll(3, 3); // point 6
		g.roll();
		const remove = g.removeBet(id);
		expect(remove.success).toBe(false);
	});
});

describe('CrapsGame — applyServerBalance', () => {
	test('updates chip balance', () => {
		const g = makeGame(1000);
		g.applyServerBalance(800);
		expect(g.getBalance()).toBe(800);
	});
});

describe('CrapsGame — state immutability', () => {
	test('getState returns defensive copies of nested state', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3);
		g.roll();

		const snapshot = g.getState() as unknown as {
			activeBets: Array<{ amount: number }>;
			rollHistory: Array<{ total: number }>;
			lastRoll: { total: number } | null;
			settings: { minBet: number };
		};

		snapshot.activeBets[0].amount = 999;
		snapshot.rollHistory[0].total = 12;
		if (snapshot.lastRoll) snapshot.lastRoll.total = 12;
		snapshot.settings.minBet = 999;

		const fresh = g.getState();
		expect(fresh.activeBets[0]?.amount).toBe(50);
		expect(fresh.rollHistory[0]?.total).toBe(6);
		expect(fresh.lastRoll?.total).toBe(6);
		expect(fresh.settings.minBet).toBe(5);
	});
});
