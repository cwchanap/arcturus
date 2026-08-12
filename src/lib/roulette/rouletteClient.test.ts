import { describe, expect, it } from 'bun:test';
import * as constants from './constants';
import { RouletteGame } from './RouletteGame';

describe('roulette browser recovery removal', () => {
	it('does not expose the old in-flight TTL constant', () => {
		expect('PENDING_SPIN_MAX_AGE_MS' in constants).toBe(false);
	});

	it('does not serialize unresolved identifiers in game state', () => {
		const game = new RouletteGame({ initialBalance: 1_000 });
		game.placeBet('red', 5);
		game.beginSpin();
		const snapshot = JSON.stringify(game.getState());
		expect(snapshot).not.toContain('pendingSyncId');
		expect(snapshot).not.toContain('pendingSyncCreatedAt');
	});
});
