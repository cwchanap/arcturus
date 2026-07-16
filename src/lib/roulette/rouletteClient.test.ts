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
