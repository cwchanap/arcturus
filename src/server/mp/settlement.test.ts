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

	test('zero deltas omitted', () => {
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

	test('player who pushes (won === committed) has delta zero and is omitted', () => {
		const payload = buildSettlePayload({
			roomCode: 'MP-CCC333',
			handId: 'h-3',
			committed: { u1: 100, u2: 100 },
			winners: [
				{ userId: 'u1', amount: 100 },
				{ userId: 'u2', amount: 100 },
			],
		});
		expect(payload.entries.length).toBe(0);
	});
});
