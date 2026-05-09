import { describe, expect, test } from 'bun:test';
import { ClientMessage, ServerMessage, PROTOCOL_VERSION, EMOTES } from './protocol';

describe('protocol', () => {
	test('PROTOCOL_VERSION is exported', () => {
		expect(typeof PROTOCOL_VERSION).toBe('number');
		expect(PROTOCOL_VERSION).toBeGreaterThan(0);
	});

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

	test('ClientMessage.parse rejects unknown emote ids', () => {
		expect(() => ClientMessage.parse({ type: 'emote', emoteId: 'not_a_real_emote' })).toThrow();
	});

	test('ServerMessage.parse accepts room_state', () => {
		const msg = ServerMessage.parse({
			type: 'room_state',
			phase: 'seating',
			seats: [],
			pot: 0,
			board: [],
			currentSeat: null,
			betToCall: 0,
			timeRemainingMs: 0,
		});
		expect(msg.type).toBe('room_state');
	});

	test('EMOTES is a non-empty fixed list', () => {
		expect(Array.isArray(EMOTES)).toBe(true);
		expect(EMOTES.length).toBeGreaterThan(0);
	});
});
