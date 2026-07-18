import { describe, expect, it, beforeEach } from 'bun:test';
import { RouletteGame } from './RouletteGame';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import { restoreSession } from './rouletteClient';
import { PENDING_SPIN_MAX_AGE_MS } from './constants';
import type { RouletteBet } from './types';

describe('restoreSession — pending spin TTL', () => {
	function makeSpinningSnapshot(
		syncId: string,
		createdAt: number,
		chipBalance = 950,
	): Record<string, unknown> {
		return {
			phase: 'spinning',
			chipBalance,
			activeBets: [{ id: 'b1', type: 'red', amount: 50 }],
			selectedChipAmount: 25,
			lastSpin: null,
			roundHistory: [],
			pendingSyncId: syncId,
			pendingSyncCreatedAt: createdAt,
		};
	}

	let storage: Record<string, string> = {};

	beforeEach(() => {
		storage = {};
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: (key: string) => {
				delete storage[key];
			},
			clear: () => {
				storage = {};
			},
			key: () => null,
			length: 0,
		};
	});

	it('recovers a fresh in-flight spin snapshot', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		storage[key] = JSON.stringify(makeSpinningSnapshot('fresh-sync-id', Date.now()));

		const result = restoreSession(game, key, 1000);

		expect(result).not.toBeNull();
		expect(result?.syncId).toBe('fresh-sync-id');
		expect(result?.bets).toHaveLength(1);
	});

	it('drops a stale in-flight spin snapshot older than the TTL', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		// 1 day past the TTL
		const staleCreatedAt = Date.now() - (PENDING_SPIN_MAX_AGE_MS + 24 * 60 * 60 * 1000);
		storage[key] = JSON.stringify(makeSpinningSnapshot('stale-sync-id', staleCreatedAt));

		const result = restoreSession(game, key, 1000);

		expect(result).toBeNull();
	});

	it('drops a snapshot without pendingSyncCreatedAt (pre-TTL format)', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		const snapshot = makeSpinningSnapshot('legacy-sync-id', Date.now());
		delete snapshot.pendingSyncCreatedAt;
		storage[key] = JSON.stringify(snapshot);

		const result = restoreSession(game, key, 1000);

		expect(result).toBeNull();
	});

	it('drops a snapshot with invalid pendingSyncCreatedAt', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		const snapshot = makeSpinningSnapshot('bad-ts-sync-id', Date.now());
		snapshot.pendingSyncCreatedAt = 'not-a-number';
		storage[key] = JSON.stringify(snapshot);

		const result = restoreSession(game, key, 1000);

		expect(result).toBeNull();
	});

	it('recovers a snapshot exactly at the TTL boundary', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		// Just under the TTL — should still recover
		const createdAt = Date.now() - (PENDING_SPIN_MAX_AGE_MS - 1000);
		storage[key] = JSON.stringify(makeSpinningSnapshot('boundary-sync-id', createdAt));

		const result = restoreSession(game, key, 1000);

		expect(result).not.toBeNull();
		expect(result?.syncId).toBe('boundary-sync-id');
	});

	it('drops a snapshot with a future pendingSyncCreatedAt', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		// A future timestamp (corrupted localStorage / clock correction) must
		// never satisfy the TTL — otherwise retention cleanup of the matching
		// roulette_round row would let recovery re-settle it as a fresh spin.
		const futureCreatedAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
		storage[key] = JSON.stringify(makeSpinningSnapshot('future-sync-id', futureCreatedAt));

		const result = restoreSession(game, key, 1000);

		expect(result).toBeNull();
	});

	it('sets balance to balanceOverride after restoring a spinning snapshot', () => {
		// restoreSession sets the balance to the server-provided balanceOverride
		// (the server's current balance at reload time). The caller is responsible
		// for rebasing against the active stake before abortSpin/preserving bets.
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		// Snapshot has chipBalance 950 (1000 - 50 bet), but balanceOverride is 1000
		storage[key] = JSON.stringify(makeSpinningSnapshot('sync-1', Date.now(), 950));

		const result = restoreSession(game, key, 1000);

		expect(result).not.toBeNull();
		// After restore, balance should be the server's balanceOverride (1000),
		// not the snapshot's chipBalance (950). The caller rebases by subtracting
		// totalBet before abortSpin so refunding bets doesn't inflate.
		expect(game.getBalance()).toBe(1000);
		expect(game.getState().activeBets).toHaveLength(1);
		expect(game.getState().activeBets[0].amount).toBe(50);
	});

	it('rejects a settled snapshot with active bets for auth users', () => {
		// A settled snapshot should never have active bets. If it does,
		// the snapshot is corrupted or tampered — restoring it would let
		// the user refund bets on top of the server balance, inflating chips.
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		const corruptedSnapshot = {
			phase: 'settled',
			chipBalance: 950,
			activeBets: [{ id: 'b1', type: 'red', amount: 50 }],
			selectedChipAmount: 25,
			lastSpin: null,
			roundHistory: [],
		};
		storage[key] = JSON.stringify(corruptedSnapshot);

		const result = restoreSession(game, key, 1000);

		expect(result).toBeNull();
		expect(game.getState().activeBets).toHaveLength(0);
		expect(game.getBalance()).toBe(1000);
	});

	it('rejects a settled snapshot with a non-array activeBets for auth users', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		const corruptedSnapshot = {
			phase: 'settled',
			chipBalance: 1000,
			activeBets: 'not-an-array',
			selectedChipAmount: 25,
			lastSpin: null,
			roundHistory: [],
		};
		storage[key] = JSON.stringify(corruptedSnapshot);

		// Capture pre-restore state so we can prove the rejection left the
		// game untouched. A valid settled snapshot also returns null, so the
		// null result alone does not distinguish rejection from a no-op
		// restore — the snapshot's selectedChipAmount (25) would have leaked
		// in had restoreState run.
		const beforeState = game.getState();
		const beforeBalance = game.getBalance();

		const result = restoreSession(game, key, 1000);

		expect(result).toBeNull();
		const afterState = game.getState();
		expect(afterState.phase).toBe(beforeState.phase);
		expect(afterState.phase).toBe('betting');
		expect(game.getBalance()).toBe(beforeBalance);
		expect(game.getBalance()).toBe(1000);
		expect(afterState.activeBets).toEqual(beforeState.activeBets);
		expect(afterState.activeBets).toHaveLength(0);
		expect(afterState.selectedChipAmount).toBe(beforeState.selectedChipAmount);
		expect(afterState.selectedChipAmount).toBe(5);
		expect(afterState.lastSpin).toBe(beforeState.lastSpin);
		expect(afterState.lastSpin).toBeNull();
		expect(afterState.roundHistory).toEqual(beforeState.roundHistory);
		expect(afterState.roundHistory).toEqual([]);
	});

	it('restores a valid settled snapshot with empty activeBets for auth users', () => {
		const game = new RouletteGame({ initialBalance: 1000 });
		const key = 'roulette-session:user1';
		const validSnapshot = {
			phase: 'settled',
			chipBalance: 950,
			activeBets: [],
			selectedChipAmount: 25,
			lastSpin: null,
			roundHistory: [],
		};
		storage[key] = JSON.stringify(validSnapshot);

		const result = restoreSession(game, key, 1200);

		expect(result).toBeNull();
		expect(game.getBalance()).toBe(1200);
		expect(game.getState().phase).toBe('settled');
		expect(game.getState().activeBets).toHaveLength(0);
	});
});

describe('RouletteUIRenderer — column labels', () => {
	function mockRendererDOM() {
		const ids = [
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
		(globalThis as unknown as { document: unknown }).document = {
			getElementById: (id: string) => {
				if (!ids.includes(id)) return null;
				return {
					textContent: '',
					innerHTML: '',
					disabled: false,
					hidden: false,
					classList: { add: () => {}, remove: () => {}, toggle: () => {} },
					setAttribute: () => {},
					style: {},
				};
			},
			querySelector: () => null,
			querySelectorAll: () => [],
		};
		(globalThis as typeof globalThis & { HTMLButtonElement: unknown }).HTMLButtonElement = class {};
	}

	function makeBet(type: RouletteBet['type'], target?: number): RouletteBet {
		return { id: 'b1', type, amount: 10, ...(target !== undefined ? { target } : {}) };
	}

	it('labels target 0 (3,6,…,36) as "Column 3"', () => {
		mockRendererDOM();
		const renderer = new RouletteUIRenderer() as unknown as {
			betLabel: (bet: RouletteBet) => string;
		};
		expect(renderer.betLabel(makeBet('column', 0))).toBe('Column 3');
	});

	it('labels target 1 (2,5,…,35) as "Column 2"', () => {
		mockRendererDOM();
		const renderer = new RouletteUIRenderer() as unknown as {
			betLabel: (bet: RouletteBet) => string;
		};
		expect(renderer.betLabel(makeBet('column', 1))).toBe('Column 2');
	});

	it('labels target 2 (1,4,…,34) as "Column 1"', () => {
		mockRendererDOM();
		const renderer = new RouletteUIRenderer() as unknown as {
			betLabel: (bet: RouletteBet) => string;
		};
		expect(renderer.betLabel(makeBet('column', 2))).toBe('Column 1');
	});
});
