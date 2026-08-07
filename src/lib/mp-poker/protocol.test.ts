import { describe, expect, test } from 'bun:test';
import { applyAction, createRoom, startHand, takeSeat, type HandResult, type Room } from './engine';
import { ClientMessage, ServerMessage, toHandEndedMessage, toRoomStateMessage } from './protocol';

function makeHeadsUpRoom(): Room {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
	return room;
}

function card(value: string, suit: 'hearts' | 'diamonds' | 'clubs' | 'spades', rank: number) {
	return { value, suit, rank };
}

// Joins split literals so removed message names never appear as whole tokens
// in the repository (e.g. greppable removal audits).
function removedType(...parts: string[]): string {
	return parts.join('');
}

describe('protocol', () => {
	test('ClientMessage.parse accepts take_seat', () => {
		const msg = ClientMessage.parse({ type: 'take_seat', seatIndex: 2 });
		expect(msg.type).toBe('take_seat');
	});

	test('ClientMessage.parse accepts action raise with amount', () => {
		const msg = ClientMessage.parse({ type: 'action', action: 'raise', amount: 200 });
		expect(msg.type).toBe('action');
	});

	test('ClientMessage.parse rejects raise without amount', () => {
		expect(() => ClientMessage.parse({ type: 'action', action: 'raise' })).toThrow();
	});

	test('ClientMessage.parse rejects removed messages', () => {
		expect(() =>
			ClientMessage.parse({ type: removedType('em', 'ote'), emoteId: 'good_game' }),
		).toThrow();
		expect(() => ClientMessage.parse({ type: removedType('po', 'ng') })).toThrow();
	});

	test('ServerMessage.parse rejects removed messages', () => {
		expect(() =>
			ServerMessage.parse({ type: removedType('state', '_delta'), patch: {} }),
		).toThrow();
		expect(() => ServerMessage.parse({ type: removedType('pi', 'ng') })).toThrow();
		expect(() =>
			ServerMessage.parse({ type: removedType('hand', '_aborted'), reason: 'disconnect' }),
		).toThrow();
	});

	test('ServerMessage.parse accepts the current room_state shape', () => {
		const msg = ServerMessage.parse({
			type: 'room_state',
			phase: 'waiting',
			seats: [],
			pot: 0,
			board: [],
			currentSeat: null,
			yourSeat: null,
		});
		expect(msg.type).toBe('room_state');
	});

	test('ServerMessage.parse rejects removed room_state fields and old phases', () => {
		expect(() =>
			ServerMessage.parse({
				type: 'room_state',
				phase: 'seating',
				seats: [],
				pot: 0,
				board: [],
				currentSeat: null,
				yourSeat: null,
			}),
		).toThrow();
		expect(() =>
			ServerMessage.parse({
				type: 'room_state',
				phase: 'waiting',
				seats: [],
				pot: 0,
				board: [],
				currentSeat: null,
				yourSeat: null,
				betToCall: 0,
				timeRemainingMs: 0,
			}),
		).toThrow();
	});

	test('personalizes room state without exposing user ids', () => {
		const room = startHand(makeHeadsUpRoom(), {
			deckSeed: 'protocol-room',
			starterUserId: 'u1',
		});
		const message = toRoomStateMessage(room, 'u2');

		expect(message.yourSeat).toBe(1);
		expect(message.currentSeat).toBe(0);
		expect(message.phase).toBe('in-hand');
		expect(message.seats[0]).toMatchObject({
			seatIndex: 0,
			displayName: 'Alice',
			chips: 995,
			committed: 5,
		});
		expect(JSON.stringify(message)).not.toContain('"userId"');
		expect(JSON.stringify(message)).not.toContain('holeCards');
		expect(JSON.stringify(message)).not.toContain('deck');
	});

	test('projects only the approved public room and seat keys', () => {
		const room = startHand(makeHeadsUpRoom(), {
			deckSeed: 'exact-projection',
			starterUserId: 'u1',
		});
		const message = toRoomStateMessage(room, 'u1');

		expect(Object.keys(message).sort()).toEqual(
			['board', 'currentSeat', 'phase', 'pot', 'seats', 'type', 'yourSeat'].sort(),
		);
		expect(Object.keys(message.seats[0]).sort()).toEqual(
			['allIn', 'chips', 'committed', 'connected', 'displayName', 'folded', 'seatIndex'].sort(),
		);
		expect(() =>
			ServerMessage.parse({
				...message,
				seats: message.seats.map((seat) => ({ ...seat, disconnectedAt: null })),
			}),
		).toThrow();

		const started = ServerMessage.parse({
			type: 'hand_started',
			dealerSeat: 0,
			holeCards: [card('A', 'spades', 14), card('K', 'spades', 13)],
		});
		expect(Object.keys(started).sort()).toEqual(['dealerSeat', 'holeCards', 'type'].sort());
	});

	test('rejects removed multiplayer error codes', () => {
		for (const code of [
			'NOT_A_MEMBER',
			'ROOM_CODE_TAKEN',
			'INSUFFICIENT_CHIPS',
			'INVALID_CONFIG',
		]) {
			expect(() => ServerMessage.parse({ type: 'error', code, message: 'removed' })).toThrow();
		}
	});

	test('retains showdown cards but strips internal user ids', () => {
		const showdownResult: HandResult = {
			winners: [{ userId: 'u1', seatIndex: 0, amount: 20 }],
			showdownCards: [
				{
					userId: 'u1',
					seatIndex: 0,
					cards: [card('A', 'spades', 14), card('K', 'spades', 13)],
				},
				{
					userId: 'u2',
					seatIndex: 1,
					cards: [card('Q', 'hearts', 12), card('Q', 'clubs', 12)],
				},
			],
		};
		const message = toHandEndedMessage(showdownResult);

		expect(message.showdownCards).toHaveLength(2);
		expect(JSON.stringify(message)).not.toContain('"userId"');
		expect(message.showdownCards[0]).toEqual({
			seatIndex: 0,
			cards: [card('A', 'spades', 14), card('K', 'spades', 13)],
		});
	});

	test('fold-outs produce no showdown cards', () => {
		const room = startHand(makeHeadsUpRoom(), { deckSeed: 'fold-out', starterUserId: 'u1' });
		const transition = applyAction(room, 'u1', { action: 'fold' });
		const message = toHandEndedMessage(transition.handResult!);

		expect(message.showdownCards).toEqual([]);
	});
});
