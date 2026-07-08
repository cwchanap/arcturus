import { describe, expect, test } from 'bun:test';
import { SlotsGame } from './SlotsGame';
import { ReelManager } from './ReelManager';
import { MAX_BET, MAX_HISTORY, MIN_BET, NUM_REELS, NUM_ROWS, PAYTABLE } from './constants';
import type { LineWin, ReelGrid, SlotsGameEvents, SymbolId } from './types';

class RiggedReels extends ReelManager {
	private forced: ReelGrid | null = null;
	force(grid: ReelGrid): void {
		this.forced = grid;
	}
	override spin(): ReelGrid {
		if (this.forced) {
			const g = this.forced;
			this.forced = null;
			return g;
		}
		return super.spin();
	}
}

function losingGrid(): ReelGrid {
	return [
		['seven', 'bell', 'bar'],
		['melon', 'grapes', 'lemon'],
		['cherry', 'seven', 'bell'],
		['bar', 'melon', 'grapes'],
		['lemon', 'cherry', 'seven'],
	];
}

describe('SlotsGame bet validation', () => {
	test('rejects bet below minimum', () => {
		const game = new SlotsGame(1000);
		expect(() => game.setBet(0)).toThrow(/BET_BELOW_MIN/);
	});

	test('rejects bet above maximum', () => {
		const game = new SlotsGame(1000);
		expect(() => game.setBet(MAX_BET + 1)).toThrow(/BET_ABOVE_MAX/);
	});

	test('rejects spin when balance is less than bet', () => {
		const game = new SlotsGame(0);
		game.setBet(MIN_BET);
		expect(() => game.spin('sync-1')).toThrow(/INSUFFICIENT_BALANCE/);
		expect(game.getBalance()).toBe(0);
	});

	test('canSpin is false when balance is below bet', () => {
		const game = new SlotsGame(0);
		game.setBet(5);
		expect(game.canSpin()).toBe(false);
	});
});

describe('SlotsGame settlement', () => {
	test('deducts the bet exactly once per spin', () => {
		const reels = new RiggedReels();
		reels.force(losingGrid());
		const game = new SlotsGame(1000, {}, {}, reels);
		game.setBet(10);
		const before = game.getBalance();
		game.spin('sync-1');
		expect(game.getBalance()).toBe(before - 10);
	});

	test('credits the correct payout exactly once', () => {
		const reels = new RiggedReels();
		const jackpot: ReelGrid = Array.from({ length: NUM_REELS }, () => ['seven', 'seven', 'seven']);
		reels.force(jackpot);
		const game = new SlotsGame(1000, {}, {}, reels);
		game.setBet(10);
		const before = game.getBalance();
		game.spin('sync-1');
		// 5 lines × seven 5-of-a-kind: linePayout(1000, 10) = 2000 each → 10000
		const expectedPayout = 5 * Math.round((PAYTABLE.seven[5] * 10) / 5);
		expect(game.getBalance()).toBe(before - 10 + expectedPayout);
	});

	test('balance never goes negative', () => {
		const game = new SlotsGame(1);
		game.setBet(1);
		game.spin('sync-1');
		expect(game.getBalance()).toBeGreaterThanOrEqual(0);
	});
});

describe('SlotsGame duplicate-settlement protection', () => {
	test('same syncId returns cached result without re-deducting or re-crediting', () => {
		const reels = new RiggedReels();
		reels.force(losingGrid());
		const game = new SlotsGame(1000, {}, {}, reels);
		game.setBet(10);
		const first = game.spin('sync-dupe');
		const balanceAfterFirst = game.getBalance();
		const second = game.spin('sync-dupe');
		expect(second).toEqual(first);
		expect(game.getBalance()).toBe(balanceAfterFirst);
	});

	test('different syncId resolves a fresh spin', () => {
		const reels = new RiggedReels();
		reels.force(losingGrid());
		const game = new SlotsGame(1000, {}, {}, reels);
		game.setBet(10);
		game.spin('sync-a');
		const bal = game.getBalance();
		reels.force(losingGrid());
		game.spin('sync-b');
		expect(game.getBalance()).toBe(bal - 10);
	});

	test('replaying a non-latest syncId returns cached result without re-executing', () => {
		const reels = new RiggedReels();
		reels.force(losingGrid());
		const game = new SlotsGame(1000, {}, {}, reels);
		game.setBet(10);
		const first = game.spin('sync-a');
		const balanceAfterFirst = game.getBalance();
		// A fresh spin with a new syncId
		reels.force(losingGrid());
		game.spin('sync-b');
		const balanceAfterSecond = game.getBalance();
		// Replaying the earlier 'sync-a' must NOT re-deduct or re-credit
		const replayed = game.spin('sync-a');
		expect(replayed).toEqual(first);
		expect(game.getBalance()).toBe(balanceAfterSecond);
		expect(game.getBalance()).not.toBe(balanceAfterFirst);
	});
});

describe('SlotsGame history', () => {
	test('caps history at MAX_HISTORY (ring buffer)', () => {
		const reels = new RiggedReels();
		const game = new SlotsGame(100_000, {}, {}, reels);
		game.setBet(1);
		for (let i = 0; i < MAX_HISTORY + 5; i++) {
			reels.force(losingGrid());
			game.spin(`sync-${i}`);
		}
		expect(game.getHistory()).toHaveLength(MAX_HISTORY);
		expect(game.getHistory()[0].syncId).toBe(`sync-${MAX_HISTORY + 4}`);
	});
});

describe('SlotsGame events', () => {
	test('emits onBalanceUpdate, onRoundComplete', () => {
		const reels = new RiggedReels();
		reels.force(losingGrid());
		const seen: string[] = [];
		const events: Partial<SlotsGameEvents> = {
			onRoundComplete: () => {
				seen.push('complete');
			},
			onBalanceUpdate: () => seen.push('balance'),
		};
		const game = new SlotsGame(1000, {}, events, reels);
		game.setBet(10);
		game.spin('sync-ev');
		expect(seen).toContain('complete');
		expect(seen.filter((s) => s === 'balance').length).toBeGreaterThan(0);
	});
});

describe('SlotsGame lineWins isolation', () => {
	// Regression: lineWins was aliased by reference between history, lastEvaluation,
	// onRoundComplete payload, and the spin() return value. Mutating any one
	// corrupted the others. All must be independent copies.
	function jackpotGrid(): ReelGrid {
		return Array.from({ length: NUM_REELS }, () => ['seven', 'seven', 'seven'] as SymbolId[]);
	}

	test('spin() return lineWins is a copy — mutating it does not affect history', () => {
		const reels = new RiggedReels();
		reels.force(jackpotGrid());
		const game = new SlotsGame(10000, {}, {}, reels);
		game.setBet(10);
		const result = game.spin('sync-iso-1');
		expect(result.lineWins.length).toBeGreaterThan(0);
		result.lineWins.push({
			paylineIndex: 99,
			symbol: 'cherry',
			count: 3,
			multiplier: 1,
			payout: 999,
		});
		const history = game.getHistory();
		expect(history[0].lineWins.length).not.toBe(result.lineWins.length);
		expect(history[0].lineWins.some((w) => w.paylineIndex === 99)).toBe(false);
	});

	test('getHistory() lineWins is a copy — mutating it does not affect internal state', () => {
		const reels = new RiggedReels();
		reels.force(jackpotGrid());
		const game = new SlotsGame(10000, {}, {}, reels);
		game.setBet(10);
		game.spin('sync-iso-2');
		const hist1 = game.getHistory();
		hist1[0].lineWins.length = 0;
		const hist2 = game.getHistory();
		expect(hist2[0].lineWins.length).toBeGreaterThan(0);
	});

	test('getState() history lineWins is a copy — mutating does not affect internal state', () => {
		const reels = new RiggedReels();
		reels.force(jackpotGrid());
		const game = new SlotsGame(10000, {}, {}, reels);
		game.setBet(10);
		game.spin('sync-iso-3');
		const state1 = game.getState();
		state1.history[0].lineWins.length = 0;
		const state2 = game.getState();
		expect(state2.history[0].lineWins.length).toBeGreaterThan(0);
	});

	test('getState() lastEvaluation lineWins is a copy — mutating does not affect internal state', () => {
		const reels = new RiggedReels();
		reels.force(jackpotGrid());
		const game = new SlotsGame(10000, {}, {}, reels);
		game.setBet(10);
		game.spin('sync-iso-4');
		const state1 = game.getState();
		expect(state1.lastEvaluation).not.toBeNull();
		state1.lastEvaluation!.lineWins.length = 0;
		const state2 = game.getState();
		expect(state2.lastEvaluation!.lineWins.length).toBeGreaterThan(0);
	});

	test('onRoundComplete payload lineWins is a copy — mutating does not affect history', () => {
		const reels = new RiggedReels();
		reels.force(jackpotGrid());
		let payloadLineWins: LineWin[] | null = null;
		const events: Partial<SlotsGameEvents> = {
			onRoundComplete: (result) => {
				payloadLineWins = result.lineWins;
			},
		};
		const game = new SlotsGame(10000, {}, events, reels);
		game.setBet(10);
		game.spin('sync-iso-5');
		expect(payloadLineWins).not.toBeNull();
		expect(payloadLineWins!.length).toBeGreaterThan(0);
		payloadLineWins!.length = 0;
		const history = game.getHistory();
		expect(history[0].lineWins.length).toBeGreaterThan(0);
	});

	test('cached spin (same syncId) returns a fresh lineWins copy each call', () => {
		const reels = new RiggedReels();
		reels.force(jackpotGrid());
		const game = new SlotsGame(10000, {}, {}, reels);
		game.setBet(10);
		const first = game.spin('sync-iso-6');
		const second = game.spin('sync-iso-6');
		expect(first.lineWins).not.toBe(second.lineWins);
		second.lineWins.length = 0;
		expect(first.lineWins.length).toBeGreaterThan(0);
	});
});
