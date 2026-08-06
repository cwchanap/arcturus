import { describe, expect, test } from 'bun:test';
import { createRoom, takeSeat, startHand } from './engine';
import {
	EMPTY_ROOM_TIMEOUT_MS,
	RECONNECT_TIMEOUT_MS,
	TURN_TIMEOUT_MS,
	getNextAlarmAt,
} from './timers';

describe('multiplayer poker timers', () => {
	test('uses the exact timeout constants', () => {
		expect(TURN_TIMEOUT_MS).toBe(60_000);
		expect(RECONNECT_TIMEOUT_MS).toBe(30_000);
		expect(EMPTY_ROOM_TIMEOUT_MS).toBe(5 * 60_000);
	});

	test('turn deadline wins when it is earliest', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
		room = startHand(room, { deckSeed: 'timer-turn' });
		const now = 1_000_000;
		expect(getNextAlarmAt(room, now + 5_000, now + 20_000, now)).toBe(now + 5_000);
	});

	test('future reconnect deadline wins over a later turn deadline', () => {
		const now = 1_000_000;
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
		room = startHand(room, { deckSeed: 'timer-reconnect' });
		room = {
			...room,
			seats: room.seats.map((seat) =>
				seat.userId === 'u1' ? { ...seat, connected: false, disconnectedAt: now - 28_000 } : seat,
			),
		};
		expect(getNextAlarmAt(room, now + 10_000, null, now)).toBe(now + 2_000);
	});

	test('persisted empty deadline wins over a later turn deadline', () => {
		const room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
		const now = 1_000_000;
		expect(getNextAlarmAt(room, now + 10_000, now + 2_000, now)).toBe(now + 2_000);
	});

	test('expired reconnect deadline is ignored while its all-in player is protected by the hand', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
		room = startHand(room, { deckSeed: 'timer-protected' });
		const protectedUserId = room.seats[room.hand!.currentSeat].userId!;
		room = {
			...room,
			seats: room.seats.map((seat) =>
				seat.userId === protectedUserId ? { ...seat, connected: false, disconnectedAt: 1 } : seat,
			),
			hand: { ...room.hand!, allIn: new Set([protectedUserId]) },
		};
		const now = 1_000_000;
		expect(getNextAlarmAt(room, now + 10_000, null, now)).toBe(now + 10_000);
	});
});
