/**
 * Unit tests for the Sic Bo game state machine
 */

import { describe, expect, test } from 'bun:test';
import { SicBoGame } from './game';

/** A sequence that maps to a known roll: [0, 0.5, 0.9] -> [1, 4, 6], total 11. */
function sequenceRandom(sequence: number[]): () => number {
	let index = 0;
	return () => sequence[index++] ?? 0;
}

describe('SicBoGame accounting', () => {
	test('single winning bet settles balance and net delta', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9])); // [1,4,6], total 11
		game.setBet('big', 10);
		expect(game.getRollError()).toBeNull();
		const result = game.roll();
		expect(result.roll).toEqual([1, 4, 6]);
		expect(result.totalStake).toBe(10);
		expect(result.grossReturn).toBe(20);
		expect(result.netDelta).toBe(10);
		expect(game.getState().balance).toBe(110);
	});

	test('mixed winning and losing slip resolves each bet independently', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9])); // [1,4,6], total 11
		game.setBet('big', 10); // wins 20
		game.setBet('small', 5); // loses
		game.setBet('total:11', 5); // wins 35
		const result = game.roll();
		expect(result.roll).toEqual([1, 4, 6]);
		expect(result.totalStake).toBe(20);
		expect(result.grossReturn).toBe(55);
		expect(result.netDelta).toBe(35);
		expect(result.results.map((r) => r.won)).toEqual([true, false, true]);
		expect(game.getState().balance).toBe(135);
	});
});

describe('SicBoGame denomination and clearing', () => {
	test('empty slip blocks rolling', () => {
		const game = new SicBoGame(100);
		expect(game.getRollError()).toContain('bet');
	});

	test('only chip denominations are accepted', () => {
		const game = new SicBoGame(100);
		expect(game.getBetError('big', 2)).not.toBeNull();
		expect(game.getBetError('big', 100)).toBeNull();
		expect(() => game.setBet('big', 2)).toThrow();
		expect(() => game.setBet('big', 0)).toThrow();
	});

	test('aggregate stake above balance is rejected', () => {
		const game = new SicBoGame(100);
		game.setBet('big', 100);
		expect(game.getBetError('small', 1)).toContain('balance');
	});

	test('clearBet removes one position', () => {
		const game = new SicBoGame(100);
		game.setBet('big', 100);
		game.clearBet('big');
		expect(game.getTotalStake()).toBe(0);
		expect(game.getState().bets['big']).toBeUndefined();
	});

	test('clearBets removes every position', () => {
		const game = new SicBoGame(100);
		game.setBet('big', 10);
		game.setBet('small', 25);
		game.setBet('total:17', 50);
		expect(game.getTotalStake()).toBe(85);
		game.clearBets();
		expect(game.getTotalStake()).toBe(0);
		expect(game.getState().bets).toEqual({});
	});
});

describe('SicBoGame retained slip recovery', () => {
	test('kept bets stay after reset and Roll stays disabled until the slip fits', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		game.setBet('small', 5);
		game.roll();
		expect(game.getState().phase).toBe('complete');

		game.resetRound();
		expect(game.getState().phase).toBe('betting');
		expect(game.getTotalStake()).toBe(15);
		expect(game.getState().bets).toEqual({ big: 10, small: 5 });

		game.setBalance(5);
		expect(game.getRollError()).toContain('balance');
		game.clearBet('small'); // stake 10, still above the new balance
		expect(game.getRollError()).toContain('balance');
	});

	test('clearBets unlocks rolling after adopting a smaller balance', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		game.setBet('small', 5);
		game.roll();
		game.resetRound();
		game.setBalance(5);
		expect(game.getRollError()).toContain('balance');
		game.clearBets();
		expect(game.getTotalStake()).toBe(0);
		expect(game.getRollError()).toContain('bet');
	});
});

describe('SicBoGame lifecycle', () => {
	test('rolling twice before reset throws', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		game.roll();
		expect(() => game.roll()).toThrow();
	});

	test('rolling an empty slip throws', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		expect(() => game.roll()).toThrow();
	});

	test('editing bets while complete throws', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		game.roll();
		expect(() => game.setBet('big', 20)).toThrow();
		expect(() => game.clearBet('big')).toThrow();
		expect(() => game.clearBets()).toThrow();
	});

	test('resetRound clears result and dice but keeps bets', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		game.roll();
		expect(game.getState().result).not.toBeNull();
		game.resetRound();
		const state = game.getState();
		expect(state.phase).toBe('betting');
		expect(state.result).toBeNull();
		expect(state.bets['big']).toBe(10);
		expect(game.getTotalStake()).toBe(10);
	});

	test('getState returns a deep copy', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		game.setBet('total:8', 25);
		game.roll(); // [1,4,6]: big wins 20, total:8 loses; stake 35, net -15

		const state = game.getState() as unknown as {
			balance: number;
			bets: Record<string, number>;
			result: { netDelta: number; roll: number[]; results: Array<{ amount: number }> };
		};
		state.bets['big'] = 999;
		state.balance = 0;
		state.result.netDelta = -999;
		state.result.roll[0] = 6;
		state.result.results[0].amount = 999;

		const fresh = game.getState();
		expect(fresh.bets['big']).toBe(10);
		expect(fresh.balance).toBe(85);
		expect(fresh.result?.netDelta).toBe(-15);
		expect(fresh.result?.roll).toEqual([1, 4, 6]);
		expect(fresh.result?.results[0].amount).toBe(10);
	});

	test('roll returns a deep copy of the stored result', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		game.setBet('big', 10);
		const result = game.roll();
		const snap = result as unknown as {
			netDelta: number;
			results: Array<{ amount: number }>;
		};
		snap.netDelta = 999;
		snap.results[0].amount = 999;

		const stored = game.getState().result;
		expect(stored?.netDelta).toBe(10);
		expect(stored?.results[0].amount).toBe(10);
	});
});

describe('SicBoGame setBalance', () => {
	test('truncates fractional balances to whole chips', () => {
		const game = new SicBoGame(100);
		game.setBalance(250.99);
		expect(game.getState().balance).toBe(250);
		game.setBalance(0.5);
		expect(game.getState().balance).toBe(0);
	});

	test('rejects negative and non-finite balances', () => {
		const game = new SicBoGame(100);
		expect(() => game.setBalance(-1)).toThrow();
		expect(() => game.setBalance(Number.NaN)).toThrow();
		expect(() => game.setBalance(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => game.setBalance(Number.NEGATIVE_INFINITY)).toThrow();
		expect(game.getState().balance).toBe(100);
	});
});

describe('SicBoGame forged bet key rejection', () => {
	test('setBet rejects forged totals and keeps the slip clean', () => {
		const game = new SicBoGame(100);
		expect(() => game.setBet('total:3' as never, 10)).toThrow();
		expect(() => game.setBet('total:18' as never, 10)).toThrow();
		expect(() => game.setBet('doubles' as never, 10)).toThrow();
		expect(game.getTotalStake()).toBe(0);
		expect(game.getState().bets).toEqual({});
	});

	test('getBetError flags forged keys without mutating state', () => {
		const game = new SicBoGame(100);
		expect(game.getBetError('total:3' as never, 10)).not.toBeNull();
		expect(game.getBetError('total:18' as never, 10)).not.toBeNull();
		expect(game.getTotalStake()).toBe(0);
	});

	test('rolling after a forged setBet attempt produces no NaN balance', () => {
		const game = new SicBoGame(100, sequenceRandom([0, 0.5, 0.9]));
		try {
			game.setBet('total:3' as never, 10);
		} catch {
			// expected
		}
		game.setBet('big', 10);
		const result = game.roll();
		expect(Number.isNaN(result.netDelta)).toBe(false);
		expect(Number.isNaN(game.getState().balance)).toBe(false);
		expect(game.getState().balance).toBe(110);
	});
});
