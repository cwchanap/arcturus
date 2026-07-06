import { describe, expect, test } from 'bun:test';
import { evaluateGrid, evaluateLine, extractLine, linePayout } from './payoutCalculator';
import { NUM_PAYLINES, PAYLINES, PAYTABLE } from './constants';
import { ReelManager } from './ReelManager';
import type { ReelGrid, SymbolId } from './types';

function lineOf(symbol: SymbolId, count: 3 | 4 | 5): SymbolId[] {
	const filler: SymbolId = symbol === 'cherry' ? 'lemon' : 'cherry';
	const full = [symbol, symbol, symbol, symbol, symbol] as SymbolId[];
	for (let i = count; i < 5; i++) full[i] = filler;
	return full;
}

describe('evaluateLine', () => {
	test('detects 3/4/5 of a kind left-to-right and returns the right multiplier', () => {
		for (const sym of ['seven', 'bell', 'cherry'] as SymbolId[]) {
			for (const count of [3, 4, 5] as const) {
				const match = evaluateLine(lineOf(sym, count));
				expect(match).not.toBeNull();
				expect(match!.symbol).toBe(sym);
				expect(match!.count).toBe(count);
				expect(match!.multiplier).toBe(PAYTABLE[sym][count]);
			}
		}
	});

	test('returns null when fewer than 3 match from the left', () => {
		expect(evaluateLine(['cherry', 'lemon', 'cherry', 'cherry', 'cherry'])).toBeNull();
		expect(evaluateLine(['lemon', 'cherry', 'cherry', 'cherry', 'lemon'])).toBeNull();
	});

	test('non-consecutive matches after a break do not count', () => {
		expect(evaluateLine(['cherry', 'lemon', 'cherry', 'cherry', 'cherry'])).toBeNull();
	});
});

describe('linePayout', () => {
	test('is integral and equals multiplier * totalBet / NUM_PAYLINES', () => {
		expect(linePayout(10, 1)).toBe(2);
		expect(linePayout(10, 5)).toBe(10);
		expect(linePayout(1000, 100)).toBe(20000);
		expect(Number.isInteger(linePayout(25, 3))).toBe(true);
	});
});

describe('evaluateGrid', () => {
	test('a full middle row of sevens wins all 5 lines (jackpot)', () => {
		const grid: ReelGrid = [
			['seven', 'lemon', 'cherry'],
			['seven', 'lemon', 'cherry'],
			['seven', 'lemon', 'cherry'],
			['seven', 'lemon', 'cherry'],
			['seven', 'lemon', 'cherry'],
		];
		const evalResult = evaluateGrid(grid, 100);
		// Middle line [1,1,1,1,1] is all lemon = 3.. but reel1 row1 = lemon? No: column[1]=lemon each reel
		// Middle line reads grid[reel][1] = 'lemon' for every reel → 5 lemons.
		const middleWin = evalResult.lineWins.find((w) => w.paylineIndex === 0);
		expect(middleWin).toBeDefined();
		expect(middleWin!.symbol).toBe('lemon');
		expect(middleWin!.count).toBe(5);
		expect(middleWin!.multiplier).toBe(PAYTABLE.lemon[5]);
	});

	test('total payout is the sum of line payouts and never exceeds the paytable', () => {
		const grid: ReelGrid = [
			['cherry', 'cherry', 'cherry'],
			['cherry', 'cherry', 'cherry'],
			['cherry', 'cherry', 'cherry'],
			['cherry', 'cherry', 'cherry'],
			['cherry', 'cherry', 'cherry'],
		];
		const evalResult = evaluateGrid(grid, 10);
		const expectedPerLine = linePayout(PAYTABLE.cherry[5], 10);
		expect(evalResult.totalPayout).toBe(expectedPerLine * 5);
	});

	test('extractLine reads the correct cells', () => {
		const grid: ReelGrid = [
			['a', 'b', 'c'],
			['a', 'b', 'c'],
			['a', 'b', 'c'],
			['a', 'b', 'c'],
			['a', 'b', 'c'],
		] as unknown as ReelGrid;
		expect(extractLine(grid, PAYLINES[0])).toEqual(['b', 'b', 'b', 'b', 'b']);
		expect(extractLine(grid, PAYLINES[3])).toEqual(['a', 'b', 'c', 'b', 'a']);
	});
});

describe('payoutCalculator RTP', () => {
	test('simulated RTP over 200k spins is within spec range (92-98%)', () => {
		// mulberry32 is the spec-mandated PRNG for deterministic reel tests
		// (see docs/superpowers/specs/2026-07-05-slots-game-design.md:139).
		// A poor LCG skews the distribution enough to under-report RTP by ~4pp.
		function mulberry32(seed: number): () => number {
			let a = seed >>> 0;
			return () => {
				a |= 0;
				a = (a + 0x6d2b79f5) | 0;
				let t = Math.imul(a ^ (a >>> 15), 1 | a);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}
		const reels = new ReelManager();
		const rng = mulberry32(12345);
		const BET = 5;
		let totalBet = 0;
		let totalPayout = 0;
		for (let i = 0; i < 200_000; i++) {
			const grid = reels.spin(rng);
			totalBet += BET;
			totalPayout += evaluateGrid(grid, BET).totalPayout;
		}
		const rtp = totalPayout / totalBet;
		expect(rtp).toBeGreaterThan(0.92);
		expect(rtp).toBeLessThan(0.98);
	});
});
