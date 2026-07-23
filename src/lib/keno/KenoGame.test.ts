// src/lib/keno/KenoGame.test.ts
import { describe, expect, test } from 'bun:test';
import { MAX_BET, MAX_HISTORY, MIN_BET, PAYTABLE_VERSION } from './constants';
import { KenoGame } from './KenoGame';
import type { KenoErrorCode } from './types';

function code(e: unknown): KenoErrorCode | undefined {
	return (e as Error & { code?: KenoErrorCode }).code;
}

describe('KenoGame setters (buildError, no toast)', () => {
	test('setBet throws buildError for invalid bets (no onError emitted)', () => {
		const errors: string[] = [];
		const g = new KenoGame(1000, {}, { onError: (e) => errors.push(e.code) });
		let thrown: unknown;
		try {
			g.setBet(MIN_BET - 1);
		} catch (error) {
			thrown = error;
		}
		expect(code(thrown)).toBe('BET_BELOW_MIN');
		expect(errors).toEqual([]); // NO toast
		expect(() => g.setBet(MAX_BET + 1)).toThrow();
		expect(() => g.setBet(Number.NaN)).toThrow();
		expect(errors).toEqual([]);
	});
	test('setBet accepts valid bets', () => {
		const g = new KenoGame(1000);
		g.setBet(3);
		expect(g.getBet()).toBe(3);
	});
	test('togglePick/clearSelection accept a 0–10 draft', () => {
		const g = new KenoGame(1000);
		g.togglePick(5);
		expect(g.getPicks()).toEqual([5]);
		g.clearSelection();
		expect(g.getPicks()).toEqual([]); // empty draft is valid
	});
	test('togglePick rejects out-of-range / duplicates via buildError (no toast)', () => {
		const errors: string[] = [];
		const g = new KenoGame(1000, {}, { onError: (e) => errors.push(e.code) });
		expect(() => g.togglePick(0)).toThrow();
		expect(() => g.togglePick(81)).toThrow();
		g.togglePick(5);
		expect(() => g.togglePick(5)).toThrow(); // duplicate
		expect(errors).toEqual([]);
	});
});

describe('KenoGame.draw (fail, toast + throw)', () => {
	test('emits onError then throws on INSUFFICIENT_BALANCE', () => {
		const errors: string[] = [];
		const g = new KenoGame(0, {}, { onError: (e) => errors.push(e.code) });
		g.togglePick(1);
		expect(() => g.draw('sync-1')).toThrow();
		expect(errors).toContain('INSUFFICIENT_BALANCE');
	});
	test('emits onError then throws on INVALID_DRAW_SELECTION (<1 pick)', () => {
		const errors: string[] = [];
		const g = new KenoGame(1000, {}, { onError: (e) => errors.push(e.code) });
		expect(() => g.draw('sync-1')).toThrow();
		expect(errors).toContain('INVALID_DRAW_SELECTION');
	});
	test('togglePick rejects 11th pick with INVALID_SELECTION (no toast)', () => {
		const errors: string[] = [];
		const g = new KenoGame(1000, {}, { onError: (e) => errors.push(e.code) });
		for (let i = 1; i <= 10; i++) g.togglePick(i);
		expect(() => g.togglePick(11)).toThrow();
		expect(errors).toEqual([]); // buildError, no toast
	});
	test('emits onError then throws on INVALID_SYNC_ID', () => {
		const errors: string[] = [];
		const g = new KenoGame(1000, {}, { onError: (e) => errors.push(e.code) });
		g.togglePick(1);
		expect(() => g.draw('')).toThrow();
		expect(errors).toContain('INVALID_SYNC_ID');
	});
	test('happy path: debits bet, credits payout, records DrawResult with outcome', () => {
		const g = new KenoGame(1000);
		g.setBet(5);
		g.togglePick(1);
		g.togglePick(2);
		g.togglePick(3);
		g.togglePick(4);
		g.togglePick(5);
		// Use a DrawManager that always draws 1..20 so picks 1..5 all hit (catch-5 of 5 → 500×).
		const drawnOverride = Array.from({ length: 20 }, (_, i) => i + 1);
		const result = g.draw('sync-1', drawnOverride);
		// 5 picks all hit: multiplier 500, payout 2500, netDelta 2495 → win
		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(2500);
		expect(result.netDelta).toBe(2495);
		expect(g.getBalance()).toBe(1000 - 5 + 2500);
		expect(result.paytableVersion).toBe(PAYTABLE_VERSION);
	});
	test('loss outcome when multiplier 0', () => {
		const g = new KenoGame(1000);
		g.setBet(5);
		g.togglePick(1);
		g.togglePick(2);
		g.togglePick(3);
		g.togglePick(4);
		// drawn 21..40 → catch-0 of 4 → multiplier 0 → loss
		const drawnOverride = Array.from({ length: 20 }, (_, i) => i + 21);
		const result = g.draw('sync-1', drawnOverride);
		expect(result.multiplier).toBe(0);
		expect(result.outcome).toBe('loss');
	});
	test('push outcome when multiplier === 1 (4-spot catch-2)', () => {
		const g = new KenoGame(1000);
		g.setBet(5);
		g.togglePick(1);
		g.togglePick(2);
		g.togglePick(3);
		g.togglePick(4);
		// catch exactly 2 of 4 → PAYTABLE[4][2] = 1 → payout = bet → push
		const drawnOverride = [
			1, 2, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
		];
		const result = g.draw('sync-1', drawnOverride);
		expect(result.multiplier).toBe(1);
		expect(result.payout).toBe(5);
		expect(result.outcome).toBe('push');
	});
	test('syncId replay returns cached DrawResult (no second debit)', () => {
		const g = new KenoGame(1000);
		g.togglePick(1);
		const r1 = g.draw(
			'sync-1',
			Array.from({ length: 20 }, (_, i) => i + 1),
		);
		const balAfter = g.getBalance();
		const r2 = g.draw('sync-1');
		expect(r2.syncId).toBe('sync-1');
		expect(g.getBalance()).toBe(balAfter); // no double-debit
	});
	test('history cap evicts at MAX_HISTORY', () => {
		const g = new KenoGame(100000);
		g.togglePick(1);
		for (let i = 0; i < MAX_HISTORY + 5; i++) {
			g.draw(
				`sync-${i}`,
				Array.from({ length: 20 }, (_, j) => j + 1),
			);
		}
		expect(g.getHistory()).toHaveLength(MAX_HISTORY);
	});
	test('canDraw gating', () => {
		const g = new KenoGame(1000);
		expect(g.canDraw()).toBe(false); // 0 picks
		g.togglePick(1);
		expect(g.canDraw()).toBe(true);
		// canDraw checks balance vs bet; bet>balance → false
		g.setBet(5);
		expect(g.canDraw()).toBe(true);
	});
});

describe('KenoGame setBalance / removePick', () => {
	test('setBalance floors negative values to 0 and emits onBalanceUpdate', () => {
		const balances: number[] = [];
		const g = new KenoGame(1000, {}, { onBalanceUpdate: (b) => balances.push(b) });
		g.setBalance(500.9);
		expect(g.getBalance()).toBe(500);
		expect(balances).toContain(500);
		g.setBalance(-10);
		expect(g.getBalance()).toBe(0);
	});
	test('removePick removes a pick and emits onSelectionChange', () => {
		const changes: number[][] = [];
		const g = new KenoGame(1000, {}, { onSelectionChange: (p) => changes.push([...p]) });
		g.togglePick(1);
		g.togglePick(2);
		g.removePick(1);
		expect(g.getPicks()).toEqual([2]);
		expect(changes.at(-1)).toEqual([2]);
	});
	test('getSettings returns a defensive copy merged with defaults', () => {
		const g = new KenoGame(1000, { soundEnabled: false });
		const s = g.getSettings();
		expect(s.soundEnabled).toBe(false);
		expect(s.animationSpeed).toBe('normal');
		// mutating the returned object must not affect internal state
		s.soundEnabled = true;
		expect(g.getSettings().soundEnabled).toBe(false);
	});
});

describe('KenoGame.quickPick', () => {
	test('quickPick replaces picks with a valid ticket of the given count', () => {
		const g = new KenoGame(1000);
		g.quickPick(7);
		expect(g.getPicks()).toHaveLength(7);
		expect(g.canDraw()).toBe(true);
	});
});
