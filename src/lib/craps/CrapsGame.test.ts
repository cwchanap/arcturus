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

describe('CrapsGame — come bet odds', () => {
	test('can add odds to an established come bet', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // point = 6
		g.roll();

		const come = g.placeBet('come', 50);
		setRoll(2, 2); // establish come point = 4
		g.roll();

		const result = g.addComeBetOdds(come.bet!.id, 100);
		expect(result.success).toBe(true);
		expect(g.getTotalAtRisk()).toBe(200); // pass 50 + come 50 + odds 100
		expect(g.getBalance()).toBe(800);
	});

	test('rejects adding odds when bet id is missing', () => {
		const g = makeGame();
		expect(g.addComeBetOdds('missing-id', 50).success).toBe(false);
	});

	test('rejects adding odds to non-come bet', () => {
		const g = makeGame();
		const line = g.placeBet('passLine', 50);
		expect(g.addComeBetOdds(line.bet!.id, 50).success).toBe(false);
	});

	test('rejects adding odds before come point is established', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // point = 6
		g.roll();

		const come = g.placeBet('come', 50);
		const result = g.addComeBetOdds(come.bet!.id, 50);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/before come point/i);
	});

	test('rejects non-finite and over-limit come odds amounts', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // point = 6
		g.roll();

		const come = g.placeBet('come', 50);
		setRoll(2, 2); // establish come point = 4
		g.roll();

		expect(g.addComeBetOdds(come.bet!.id, Number.NaN).success).toBe(false);
		expect(g.addComeBetOdds(come.bet!.id, 0).success).toBe(false);
		expect(g.addComeBetOdds(come.bet!.id, 101).success).toBe(false); // max is 2x line amount
	});

	test('rejects odds when chip balance or existing bet values are invalid', () => {
		const g = makeGame();
		g.placeBet('passLine', 50);
		setRoll(3, 3); // point = 6
		g.roll();

		const come = g.placeBet('come', 50);
		setRoll(2, 2); // establish come point = 4
		g.roll();

		(g as any).state.chipBalance = Number.NaN;
		expect(g.addComeBetOdds(come.bet!.id, 10).success).toBe(false);

		(g as any).state.chipBalance = 1000;
		const idx = (g as any).state.activeBets.findIndex((b: { id: string }) => b.id === come.bet!.id);
		(g as any).state.activeBets[idx].amount = Number.NaN;
		expect(g.addComeBetOdds(come.bet!.id, 10).success).toBe(false);
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
		expect(g.getState().phase).toBe('point');
		const r = g.placeBet('passLineOdds', 100);
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/No Pass Line/i);
	});
});

describe('CrapsGame — numeric guardrails', () => {
	test('rejects non-finite bet amounts', () => {
		const g = makeGame();

		expect(g.placeBet('passLine', Number.NaN).success).toBe(false);
		expect(g.placeBet('passLine', Number.POSITIVE_INFINITY).success).toBe(false);
		expect(g.placeBet('passLine', Number.NEGATIVE_INFINITY).success).toBe(false);
	});

	test('sanitizes invalid settings in constructor and updates', () => {
		const g = new CrapsGame({
			initialBalance: 1000,
			settings: {
				minBet: Number.NaN,
				maxBet: Number.POSITIVE_INFINITY,
				maxOddsMultiplier: 0,
			},
		});

		const initial = g.getState().settings;
		expect(initial.minBet).toBe(5);
		expect(initial.maxBet).toBe(500);
		expect(initial.maxOddsMultiplier).toBe(1);

		g.updateSettings({ minBet: 700, maxBet: 100, maxOddsMultiplier: Number.NaN });
		const updated = g.getState().settings;
		expect(updated.minBet).toBe(100);
		expect(updated.maxBet).toBe(100);
		expect(updated.maxOddsMultiplier).toBe(2);
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
		// Persistent bets: payout only (stake stays on table)
		// 1000 - 50 - 60 + 70 (payout) = 960
		expect(g.getBalance()).toBe(960);
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

describe('CrapsGame — clear bets', () => {
	test('clearBets keeps locked bets and refunds removable bets', () => {
		const g = makeGame();

		g.placeBet('passLine', 100);
		setRoll(3, 3); // point = 6
		g.roll();

		const come = g.placeBet('come', 50);
		setRoll(2, 2); // establish come point = 4
		g.roll();
		expect(come.success).toBe(true);

		g.placeBet('place8', 60);
		expect(g.getBalance()).toBe(790);

		g.clearBets();

		const state = g.getState();
		expect(state.activeBets.some((b) => b.type === 'passLine')).toBe(true);
		expect(state.activeBets.some((b) => b.type === 'come' && b.point === 4)).toBe(true);
		expect(state.activeBets.some((b) => b.type === 'place8')).toBe(false);
		expect(g.getBalance()).toBe(850);
	});
});

describe('CrapsGame — applyServerBalance', () => {
	test('updates chip balance', () => {
		const g = makeGame(1000);
		g.applyServerBalance(800);
		expect(g.getBalance()).toBe(800);
	});

	test('setBalance updates on valid values and rejects invalid values', () => {
		const g = makeGame(1000);
		expect(g.setBalance(750)).toBe(true);
		expect(g.getBalance()).toBe(750);
		expect(g.setBalance(-1)).toBe(false);
		expect(g.setBalance(Number.NaN)).toBe(false);
		expect(g.getBalance()).toBe(750);
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
