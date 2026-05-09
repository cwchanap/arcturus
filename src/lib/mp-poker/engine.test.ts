import { describe, expect, test } from 'bun:test';
import { createRoom, takeSeat, leaveSeat, startHand, applyAction } from './engine';

describe('engine — seating', () => {
	test('createRoom returns room in idle phase with correct config', () => {
		const room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		expect(room.phase).toBe('idle');
		expect(room.config.maxSeats).toBe(4);
		expect(room.config.smallBlind).toBe(5);
		expect(room.config.bigBlind).toBe(10);
		expect(room.seats.length).toBe(4);
		expect(room.seats.every((s) => s.userId === null)).toBe(true);
	});

	test('takeSeat seats a user and moves to seating phase', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(room.phase).toBe('seating');
		expect(room.seats[0].userId).toBe('u1');
		expect(room.seats[0].displayName).toBe('Alice');
	});

	test('takeSeat rejects already-occupied seat', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		try {
			takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 0, mainBalance: 1000 });
			throw new Error('expected throw');
		} catch (err) {
			expect((err as { code?: string }).code).toBe('INVALID_SEAT');
		}
	});

	test('leaveSeat empties seat and returns to idle if last to leave', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = leaveSeat(room, 'u1');
		expect(room.phase).toBe('idle');
		expect(room.seats[0].userId).toBeNull();
	});

	test('startHand requires at least 2 seated players', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(() => startHand(room, { snapshots: { u1: 1000 }, deckSeed: 'seed-x' })).toThrow();
	});

	test('startHand with 2 players posts blinds and deals 2 hole cards each', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-x' });
		expect(room.phase).toBe('in-hand');
		expect(room.hand).not.toBeNull();
		expect(room.hand!.bettingRound).toBe('preflop');
		expect(room.hand!.holeCards.u1.length).toBe(2);
		expect(room.hand!.holeCards.u2.length).toBe(2);
		expect(room.hand!.committed.u1 + room.hand!.committed.u2).toBe(15);
	});
});

describe('engine — betting', () => {
	function setupHand() {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		return startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-x' });
	}

	test('fold ends hand if only one player remains', () => {
		const room = setupHand();
		const after = applyAction(room, 'u1', { action: 'fold' });
		expect(after.phase).toBe('settling');
		expect(after.handLog[after.handLog.length - 1].winners[0].seatIndex).toBe(1);
	});

	test('call advances betting round when action closes', () => {
		const room = setupHand();
		const r1 = applyAction(room, 'u1', { action: 'call' });
		expect(r1.hand!.bettingRound).toBe('preflop');
		const r2 = applyAction(r1, 'u2', { action: 'check' });
		expect(r2.hand!.bettingRound).toBe('flop');
		expect(r2.hand!.board.length).toBe(3);
	});

	test('raise must be at least min-raise', () => {
		const room = setupHand();
		expect(() => applyAction(room, 'u1', { action: 'raise', amount: 11 })).toThrow();
	});

	test('rejects action when not your turn', () => {
		const room = setupHand();
		try {
			applyAction(room, 'u2', { action: 'call' });
			throw new Error('expected throw');
		} catch (err) {
			expect((err as { code?: string }).code).toBe('NOT_YOUR_TURN');
		}
	});

	test('full hand to showdown produces hand_log entry', () => {
		const room = setupHand();
		let r = applyAction(room, 'u1', { action: 'call' });
		r = applyAction(r, 'u2', { action: 'check' });
		// flop: in heads-up post-flop, BB acts first. After preflop dealer was u1 (sb), so u2 is BB.
		// First post-flop seat = first eligible after dealer u1 → u2.
		r = applyAction(r, 'u2', { action: 'check' });
		r = applyAction(r, 'u1', { action: 'check' });
		r = applyAction(r, 'u2', { action: 'check' });
		r = applyAction(r, 'u1', { action: 'check' });
		r = applyAction(r, 'u2', { action: 'check' });
		r = applyAction(r, 'u1', { action: 'check' });
		expect(r.phase).toBe('settling');
		expect(r.handLog.length).toBe(1);
	});
});
