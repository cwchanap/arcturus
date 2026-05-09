import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const EMOTES = ['nice_hand', 'fold', 'call', 'good_game', 'thinking'] as const;
export type EmoteId = (typeof EMOTES)[number];

const CardSchema = z.object({
	value: z.string(),
	suit: z.enum(['hearts', 'diamonds', 'clubs', 'spades']),
	rank: z.number().int().min(2).max(14),
});

const SeatSchema = z.object({
	seatIndex: z.number().int().min(0).max(5),
	userId: z.string().nullable(),
	displayName: z.string().nullable(),
	chips: z.number().int().min(0),
	committed: z.number().int().min(0),
	folded: z.boolean(),
	allIn: z.boolean(),
	connected: z.boolean(),
	disconnectedAt: z.number().nullable(),
});

const PhaseSchema = z.enum(['idle', 'seating', 'in-hand', 'settling', 'frozen']);

// Client → server

const TakeSeat = z.object({
	type: z.literal('take_seat'),
	seatIndex: z.number().int().min(0).max(5),
});
const LeaveSeat = z.object({ type: z.literal('leave_seat') });
const StartHand = z.object({ type: z.literal('start_hand') });
const Action = z.discriminatedUnion('action', [
	z.object({ type: z.literal('action'), action: z.literal('fold') }),
	z.object({ type: z.literal('action'), action: z.literal('check') }),
	z.object({ type: z.literal('action'), action: z.literal('call') }),
	z.object({
		type: z.literal('action'),
		action: z.literal('bet'),
		amount: z.number().int().positive(),
	}),
	z.object({
		type: z.literal('action'),
		action: z.literal('raise'),
		amount: z.number().int().positive(),
	}),
	z.object({ type: z.literal('action'), action: z.literal('all_in') }),
]);
const Emote = z.object({ type: z.literal('emote'), emoteId: z.enum(EMOTES) });
const Pong = z.object({ type: z.literal('pong') });

export const ClientMessage = z.discriminatedUnion('type', [
	TakeSeat,
	LeaveSeat,
	StartHand,
	Action,
	Emote,
	Pong,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// Server → client

const RoomState = z.object({
	type: z.literal('room_state'),
	phase: PhaseSchema,
	seats: z.array(SeatSchema),
	pot: z.number().int().min(0),
	board: z.array(CardSchema),
	currentSeat: z.number().int().nullable(),
	betToCall: z.number().int().min(0),
	timeRemainingMs: z.number().int().min(0),
});
const StateDelta = z.object({
	type: z.literal('state_delta'),
	patch: z.record(z.string(), z.unknown()),
});
const HandStarted = z.object({
	type: z.literal('hand_started'),
	dealerSeat: z.number().int(),
	holeCards: z.tuple([CardSchema, CardSchema]),
});
const HandEnded = z.object({
	type: z.literal('hand_ended'),
	winners: z.array(z.object({ seatIndex: z.number().int(), amount: z.number().int() })),
	pots: z.array(z.object({ amount: z.number().int(), eligibleSeats: z.array(z.number().int()) })),
	showdownCards: z.array(
		z.object({
			seatIndex: z.number().int(),
			cards: z.tuple([CardSchema, CardSchema]),
		}),
	),
});
const HandAborted = z.object({ type: z.literal('hand_aborted'), reason: z.string() });
const EmoteReceived = z.object({
	type: z.literal('emote_received'),
	fromSeat: z.number().int(),
	emoteId: z.enum(EMOTES),
});
const ErrorMsg = z.object({
	type: z.literal('error'),
	code: z.enum([
		'BAD_MESSAGE',
		'NOT_YOUR_TURN',
		'INSUFFICIENT_CHIPS',
		'ALREADY_IN_ROOM',
		'SETTLEMENT_FAILED',
		'NOT_A_MEMBER',
		'ROOM_CODE_TAKEN',
		'INVALID_SEAT',
		'INVALID_ACTION',
		'INVALID_CONFIG',
		'NOT_ENOUGH_PLAYERS',
	]),
	message: z.string(),
});
const Ping = z.object({ type: z.literal('ping') });
const Kicked = z.object({ type: z.literal('kicked'), reason: z.string() });

export const ServerMessage = z.discriminatedUnion('type', [
	RoomState,
	StateDelta,
	HandStarted,
	HandEnded,
	HandAborted,
	EmoteReceived,
	ErrorMsg,
	Ping,
	Kicked,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type Seat = z.infer<typeof SeatSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type ProtocolCard = z.infer<typeof CardSchema>;
