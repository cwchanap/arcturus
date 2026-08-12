import { describe, expect, it } from 'bun:test';
import { RouletteGame } from './RouletteGame';
import { MAX_BET_PER_POSITION, MAX_BETS, MAX_TOTAL_BET } from './constants';
import type { SpinResult } from './types';

function newGame(balance = 1_000): RouletteGame {
	return new RouletteGame({ initialBalance: balance });
}

describe('RouletteGame betting', () => {
	it('deducts and merges bets by position', () => {
		const game = newGame();
		game.placeBet('straight', 25, 17);
		game.placeBet('straight', 25, 17);

		expect(game.getBalance()).toBe(950);
		expect(game.getState().activeBets).toEqual([
			expect.objectContaining({ type: 'straight', target: 17, amount: 50 }),
		]);
	});

	it('enforces per-position, total, count, and balance limits', () => {
		const game = newGame(100_000);
		game.placeBet('straight', MAX_BET_PER_POSITION, 17);
		expect(game.canPlaceBet('straight', 1, 17).ok).toBe(false);

		for (let i = 1; i < 11; i++) game.placeBet('straight', 500, i);
		expect(game.canPlaceBet('straight', 1, 20).ok).toBe(false);

		const capped = newGame(100_000);
		const bets = Array.from({ length: MAX_BETS }, (_, i) => ({
			id: `pre-${i}`,
			type: 'straight' as const,
			amount: 1,
			target: i % 37,
		}));
		expect(
			capped.restoreState({
				phase: 'betting',
				activeBets: bets,
				chipBalance: 100_000 - MAX_BETS,
				selectedChipAmount: 1,
				lastSpin: null,
				roundHistory: [],
			}),
		).toBe(true);
		expect(capped.canPlaceBet('red', 1).ok).toBe(false);

		const poor = newGame(5);
		expect(poor.placeBet('red', 6).success).toBe(false);
		expect(MAX_TOTAL_BET).toBe(5_000);
	});

	it('refunds bets while betting and refuses refunds while spinning', () => {
		const game = newGame();
		const placed = game.placeBet('red', 50);
		expect(placed.bet).toBeDefined();
		expect(game.removeBet(placed.bet!.id).success).toBe(true);
		expect(game.getBalance()).toBe(1_000);

		game.placeBet('red', 50);
		game.beginSpin();
		const before = game.getBalance();
		expect(game.clearBets()).toBeUndefined();
		expect(game.getBalance()).toBe(before);
		expect(game.getState().activeBets).toHaveLength(1);
	});
});

describe('RouletteGame settlement', () => {
	it('settles guest spins locally and records history', () => {
		const game = newGame();
		game.placeBet('straight', 10, 17);
		const result = game.spinGuest(17);

		expect(result.netDelta).toBe(350);
		expect(game.getBalance()).toBe(1_350);
		expect(game.getState().phase).toBe('settled');
		expect(game.getState().activeBets).toHaveLength(0);
		expect(game.getState().lastSpin).toBe(result);
		expect(game.getState().roundHistory).toHaveLength(1);
	});

	it('requires a server balance when applying an authenticated settlement', () => {
		const game = newGame();
		game.placeBet('red', 50);
		game.beginSpin();
		const result: SpinResult = {
			winningNumber: 1,
			bets: [{ id: 'b1', type: 'red', amount: 50 }],
			totalBet: 50,
			totalPayout: 100,
			netDelta: 50,
			results: [{ bet: { id: 'b1', type: 'red', amount: 50 }, won: true, payout: 100 }],
			timestamp: Date.now(),
			syncId: 'spin-1',
			newBalance: 1_050,
		};

		game.applySettlement(result);
		expect(game.getBalance()).toBe(1_050);
		expect(game.getState().phase).toBe('settled');
		expect(() => game.applySettlement({ ...result, newBalance: undefined })).toThrow(
			'applySettlement requires a finite server-provided newBalance',
		);
		expect(() => game.applySettlement({ ...result, newBalance: NaN })).toThrow(
			'applySettlement requires a finite server-provided newBalance',
		);
	});

	it('discards unresolved bets without refunding an adopted balance', () => {
		const game = newGame();
		game.placeBet('red', 500);
		game.beginSpin();
		game.setBalance(999);
		game.discardActiveBets();

		expect(game.getBalance()).toBe(999);
		expect(game.getState().phase).toBe('betting');
		expect(game.getState().activeBets).toHaveLength(0);
	});

	it('can abort a definitively rejected spin while preserving its layout', () => {
		const game = newGame();
		game.placeBet('red', 50);
		game.beginSpin();
		game.abortSpin();

		expect(game.getState().phase).toBe('betting');
		expect(game.getState().activeBets).toHaveLength(1);
		expect(game.getBalance()).toBe(950);
	});
});

describe('RouletteGame persistence boundary', () => {
	it('does not expose a persisted sync identifier or timestamp', () => {
		const game = newGame();
		game.placeBet('red', 50);
		game.beginSpin();

		expect('pendingSyncId' in game.getState()).toBe(false);
		expect('pendingSyncCreatedAt' in game.getState()).toBe(false);
		expect((game as unknown as { setPendingSyncId?: unknown }).setPendingSyncId).toBeUndefined();
	});

	it('restores valid non-pending state but strips obsolete snapshot fields', () => {
		const game = newGame();
		expect(
			game.restoreState({
				phase: 'spinning',
				chipBalance: 950,
				activeBets: [{ id: 'b1', type: 'red', amount: 50 }],
				pendingSyncId: 'obsolete',
				pendingSyncCreatedAt: Date.now(),
			}),
		).toBe(true);
		expect(game.getState().phase).toBe('spinning');
		expect('pendingSyncId' in game.getState()).toBe(false);
		expect('pendingSyncCreatedAt' in game.getState()).toBe(false);
	});

	it('rejects invalid snapshots and aggregate-limit violations', () => {
		const game = newGame();
		expect(game.restoreState(null)).toBe(false);
		expect(game.restoreState({ phase: 'invalid' })).toBe(false);
		expect(
			game.restoreState({
				phase: 'spinning',
				chipBalance: 1_000,
				activeBets: [{ id: 'b1', type: 'straight', amount: 5_001, target: 0 }],
			}),
		).toBe(false);
	});
});
