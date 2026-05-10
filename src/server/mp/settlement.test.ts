import { describe, expect, test } from 'bun:test';
import { buildSettlePayload } from './settlement';

describe('buildSettlePayload', () => {
	test('builds deltas: winnings minus committed for each player', () => {
		const payload = buildSettlePayload({
			roomCode: 'MP-AAA111',
			handId: 'h-1',
			committed: { u1: 100, u2: 100 },
			winners: [{ userId: 'u2', amount: 200 }],
		});
		const byUser = Object.fromEntries(payload.entries.map((e) => [e.userId, e]));
		expect(byUser.u1.delta).toBe(-100);
		expect(byUser.u2.delta).toBe(100);
		expect(byUser.u1.syncId).toBe('mp-poker:MP-AAA111:h-1:u1');
		expect(byUser.u2.syncId).toBe('mp-poker:MP-AAA111:h-1:u2');
	});

	test('calculates deltas for winner and loser with unequal committed', () => {
		const payload = buildSettlePayload({
			roomCode: 'MP-BBB222',
			handId: 'h-2',
			committed: { u1: 50, u2: 100 },
			winners: [{ userId: 'u2', amount: 150 }],
		});
		expect(payload.entries.length).toBe(2);
		const byUser = Object.fromEntries(payload.entries.map((e) => [e.userId, e]));
		expect(byUser.u1.delta).toBe(-50);
		expect(byUser.u2.delta).toBe(50);
	});

	test('player who pushes (won === committed) is included with zero delta for escrow release', () => {
		const payload = buildSettlePayload({
			roomCode: 'MP-CCC333',
			handId: 'h-3',
			committed: { u1: 100, u2: 100 },
			winners: [
				{ userId: 'u1', amount: 100 },
				{ userId: 'u2', amount: 100 },
			],
		});
		// Zero-delta entries must still be included so the settle API
		// releases each player's heldChips back to chipBalance.
		expect(payload.entries.length).toBe(2);
		const byUser = Object.fromEntries(payload.entries.map((e) => [e.userId, e]));
		expect(byUser.u1.delta).toBe(0);
		expect(byUser.u2.delta).toBe(0);
	});

	test('side pot scenario: short-stack winner gets only main pot', () => {
		// u1 all-in for 10, u2 and u3 each committed 100
		// u1 wins main pot (30), u2 wins side pot (180)
		const payload = buildSettlePayload({
			roomCode: 'MP-DDD444',
			handId: 'h-4',
			committed: { u1: 10, u2: 100, u3: 100 },
			winners: [
				{ userId: 'u1', amount: 30 },
				{ userId: 'u2', amount: 180 },
			],
		});
		const byUser = Object.fromEntries(payload.entries.map((e) => [e.userId, e]));
		expect(byUser.u1.delta).toBe(20); // won 30 - committed 10
		expect(byUser.u2.delta).toBe(80); // won 180 - committed 100
		expect(byUser.u3.delta).toBe(-100); // won 0 - committed 100
	});

	test('settlement deltas are zero-sum (total delta equals zero)', () => {
		// Verify no chips are created or destroyed
		const payload = buildSettlePayload({
			roomCode: 'MP-ZEROSUM',
			handId: 'h-zs',
			committed: { u1: 100, u2: 200, u3: 150 },
			winners: [{ userId: 'u2', amount: 450 }],
		});
		const totalDelta = payload.entries.reduce((sum, e) => sum + e.delta, 0);
		expect(totalDelta).toBe(0);
	});

	test('split pot with odd chips still produces zero-sum deltas', () => {
		// If engine distributes odd chips correctly, the winner amounts
		// should sum to total committed, making deltas zero-sum
		const totalCommitted = 103; // odd number
		const payload = buildSettlePayload({
			roomCode: 'MP-ODD',
			handId: 'h-odd',
			committed: { u1: 50, u2: 53 },
			// Engine should split 103 as 52+51 or similar, not 51+51 (losing 1)
			winners: [
				{ userId: 'u1', amount: 52 },
				{ userId: 'u2', amount: 51 },
			],
		});
		const totalDelta = payload.entries.reduce((sum, e) => sum + e.delta, 0);
		expect(totalDelta).toBe(0);
	});

	test('every committed player receives an entry regardless of delta', () => {
		// Even a player who neither won nor lost (e.g. folded early, side pot
		// returns exactly their committed amount) must get a settle entry so
		// the API releases their heldChips escrow.
		const payload = buildSettlePayload({
			roomCode: 'MP-ESCROW',
			handId: 'h-esc',
			committed: { u1: 100, u2: 50, u3: 25 },
			winners: [
				{ userId: 'u1', amount: 125 }, // wins u2+u3 committed
				{ userId: 'u2', amount: 50 }, // push — gets committed back
				{ userId: 'u3', amount: 0 }, // loses
			],
		});
		expect(payload.entries.length).toBe(3);
		const byUser = Object.fromEntries(payload.entries.map((e) => [e.userId, e]));
		expect(byUser.u1.delta).toBe(25);
		expect(byUser.u2.delta).toBe(0);
		expect(byUser.u3.delta).toBe(-25);
	});
});
