import { z } from 'zod';
import type { HandResult, Room } from './engine';

const CardSchema = z
	.object({
		value: z.string(),
		suit: z.enum(['hearts', 'diamonds', 'clubs', 'spades']),
		rank: z.number().int().min(2).max(14),
	})
	.strict();

export type ProtocolCard = z.infer<typeof CardSchema>;

const PublicSeatSchema = z
	.object({
		seatIndex: z.number().int().min(0).max(5),
		displayName: z.string().nullable(),
		chips: z.number().int().min(0),
		committed: z.number().int().min(0),
		folded: z.boolean(),
		allIn: z.boolean(),
		connected: z.boolean(),
		disconnectedAt: z.number().nullable(),
	})
	.strict();

export type PublicSeat = z.infer<typeof PublicSeatSchema>;

const PhaseSchema = z.enum(['waiting', 'in-hand']);
export type Phase = z.infer<typeof PhaseSchema>;

// Client → server

const TakeSeat = z
	.object({
		type: z.literal('take_seat'),
		seatIndex: z.number().int().min(0).max(5),
	})
	.strict();
const LeaveSeat = z.object({ type: z.literal('leave_seat') }).strict();
const StartHand = z.object({ type: z.literal('start_hand') }).strict();
const Action = z.discriminatedUnion('action', [
	z.object({ type: z.literal('action'), action: z.literal('fold') }).strict(),
	z.object({ type: z.literal('action'), action: z.literal('check') }).strict(),
	z.object({ type: z.literal('action'), action: z.literal('call') }).strict(),
	z
		.object({
			type: z.literal('action'),
			action: z.literal('bet'),
			amount: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			type: z.literal('action'),
			action: z.literal('raise'),
			amount: z.number().int().positive(),
		})
		.strict(),
	z.object({ type: z.literal('action'), action: z.literal('all_in') }).strict(),
]);

export const ClientMessage = z.discriminatedUnion('type', [TakeSeat, LeaveSeat, StartHand, Action]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// Server → client

export interface RoomStateMessage {
	type: 'room_state';
	phase: Phase;
	seats: PublicSeat[];
	pot: number;
	board: ProtocolCard[];
	currentSeat: number | null;
	yourSeat: number | null;
}

const RoomState = z
	.object({
		type: z.literal('room_state'),
		phase: PhaseSchema,
		seats: z.array(PublicSeatSchema),
		pot: z.number().int().min(0),
		board: z.array(CardSchema),
		currentSeat: z.number().int().nullable(),
		yourSeat: z.number().int().nullable(),
	})
	.strict();

const HandStarted = z
	.object({
		type: z.literal('hand_started'),
		dealerSeat: z.number().int(),
		holeCards: z.tuple([CardSchema, CardSchema]),
	})
	.strict();

export interface HandEndedMessage {
	type: 'hand_ended';
	winners: Array<{ seatIndex: number; amount: number }>;
	showdownCards: Array<{
		seatIndex: number;
		cards: [ProtocolCard, ProtocolCard];
	}>;
}

const HandEnded = z
	.object({
		type: z.literal('hand_ended'),
		winners: z.array(z.object({ seatIndex: z.number().int(), amount: z.number().int() }).strict()),
		showdownCards: z.array(
			z
				.object({
					seatIndex: z.number().int(),
					cards: z.tuple([CardSchema, CardSchema]),
				})
				.strict(),
		),
	})
	.strict();

const ErrorMsg = z
	.object({
		type: z.literal('error'),
		code: z.enum([
			'BAD_MESSAGE',
			'NOT_YOUR_TURN',
			'INSUFFICIENT_CHIPS',
			'NOT_A_MEMBER',
			'ROOM_CODE_TAKEN',
			'INVALID_SEAT',
			'INVALID_ACTION',
			'INVALID_CONFIG',
			'NOT_ENOUGH_PLAYERS',
		]),
		message: z.string(),
	})
	.strict();

export const ServerMessage = z.discriminatedUnion('type', [
	RoomState,
	HandStarted,
	HandEnded,
	ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export function toRoomStateMessage(room: Room, viewerUserId: string): RoomStateMessage {
	const hand = room.hand;
	return {
		type: 'room_state',
		phase: room.phase,
		seats: room.seats.map((seat) => ({
			seatIndex: seat.seatIndex,
			displayName: seat.displayName,
			chips: seat.chips,
			committed: seat.userId && hand ? (hand.committed[seat.userId] ?? 0) : 0,
			folded: !!(seat.userId && hand?.folded.has(seat.userId)),
			allIn: !!(seat.userId && hand?.allIn.has(seat.userId)),
			connected: seat.connected,
			disconnectedAt: seat.disconnectedAt,
		})),
		pot: hand ? Object.values(hand.committed).reduce((sum, value) => sum + value, 0) : 0,
		board: hand?.board ?? [],
		currentSeat: hand?.currentSeat ?? null,
		yourSeat: room.seats.find((seat) => seat.userId === viewerUserId)?.seatIndex ?? null,
	};
}

export function toHandEndedMessage(result: HandResult): HandEndedMessage {
	return {
		type: 'hand_ended',
		winners: result.winners.map(({ seatIndex, amount }) => ({ seatIndex, amount })),
		showdownCards: result.showdownCards.map(({ seatIndex, cards }) => ({ seatIndex, cards })),
	};
}
