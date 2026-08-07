import type { Card, Player } from '../poker/types';
import { determineShowdownWinners } from '../poker/handEvaluator';

export interface RoomConfig {
	maxSeats: 2 | 4 | 6;
	smallBlind: number;
	bigBlind: number;
}

export interface SeatState {
	seatIndex: number;
	userId: string | null;
	displayName: string | null;
	chips: number;
	connected: boolean;
	disconnectedAt: number | null;
}

export interface HandState {
	bettingRound: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
	dealerSeat: number;
	currentSeat: number;
	deck: Card[];
	board: Card[];
	holeCards: Record<string, Card[]>;
	committed: Record<string, number>;
	currentBet: number;
	lastRaiseAmount: number;
	folded: Set<string>;
	allIn: Set<string>;
	hasActed: Set<string>;
	/** Immutable userId → seatIndex mapping captured at deal time. */
	seatIndexMap: Record<string, number>;
}

export interface HandWinner {
	userId: string;
	seatIndex: number;
	amount: number;
}

export interface ShowdownCard {
	userId: string;
	seatIndex: number;
	cards: [Card, Card];
}

export interface HandResult {
	winners: HandWinner[];
	showdownCards: ShowdownCard[];
}

export interface RoomTransition {
	room: Room;
	handResult: HandResult | null;
}

export interface Room {
	config: RoomConfig;
	phase: 'waiting' | 'in-hand';
	seats: SeatState[];
	hand: HandState | null;
	lastDealerSeat: number;
}

export class EngineError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'EngineError';
	}
}

function invalidConfig(message: string): never {
	throw new EngineError('INVALID_CONFIG', message);
}

function validateConfig(config: RoomConfig): void {
	if (config.maxSeats !== 2 && config.maxSeats !== 4 && config.maxSeats !== 6) {
		invalidConfig('maxSeats must be 2, 4, or 6');
	}
	if (!Number.isSafeInteger(config.smallBlind) || config.smallBlind <= 0) {
		invalidConfig('smallBlind must be a positive safe integer');
	}
	if (!Number.isSafeInteger(config.bigBlind) || config.bigBlind <= 0) {
		invalidConfig('bigBlind must be a positive safe integer');
	}
	if (config.smallBlind > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
		invalidConfig('smallBlind is too large');
	}
	if (config.bigBlind < config.smallBlind * 2) {
		invalidConfig('bigBlind must be at least twice smallBlind');
	}
	if (!Number.isSafeInteger(config.bigBlind * 100)) {
		invalidConfig('bigBlind * 100 must be a safe integer');
	}
}

export function createRoom(config: RoomConfig): Room {
	validateConfig(config);
	const seats: SeatState[] = [];
	for (let i = 0; i < config.maxSeats; i++) {
		seats.push({
			seatIndex: i,
			userId: null,
			displayName: null,
			chips: 0,
			connected: false,
			disconnectedAt: null,
		});
	}
	return { config, phase: 'waiting', seats, hand: null, lastDealerSeat: -1 };
}

export function takeSeat(
	room: Room,
	args: { userId: string; displayName: string; seatIndex: number },
): Room {
	if (room.phase === 'in-hand') {
		throw new EngineError('INVALID_PHASE', 'cannot take seat during active hand');
	}
	const { userId, displayName, seatIndex } = args;
	if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= room.seats.length) {
		throw new EngineError('INVALID_SEAT', 'seat out of range');
	}
	if (room.seats[seatIndex].userId !== null) {
		throw new EngineError('INVALID_SEAT', 'seat occupied');
	}
	if (room.seats.some((seat) => seat.userId === userId)) {
		throw new EngineError('INVALID_SEAT', 'user already seated');
	}
	const startingChips = room.config.bigBlind * 100;
	const seats = room.seats.map((seat, index) =>
		index === seatIndex
			? {
					...seat,
					userId,
					displayName,
					chips: startingChips,
					connected: true,
					disconnectedAt: null,
				}
			: seat,
	);
	return { ...room, seats };
}

export function leaveSeat(room: Room, userId: string): Room {
	if (room.phase === 'in-hand') {
		throw new EngineError('INVALID_PHASE', 'cannot leave seat during active hand; fold instead');
	}
	const seats = room.seats.map((seat) =>
		seat.userId === userId
			? {
					...seat,
					userId: null,
					displayName: null,
					chips: 0,
					connected: false,
					disconnectedAt: null,
				}
			: seat,
	);
	return { ...room, seats };
}

export function clearDisconnectedSeat(room: Room, userId: string): Room {
	let cleared = false;
	const seats = room.seats.map((seat) => {
		if (seat.userId !== userId || seat.connected) return seat;
		cleared = true;
		return {
			...seat,
			userId: null,
			displayName: null,
			chips: 0,
			connected: false,
			disconnectedAt: null,
		};
	});
	return cleared ? { ...room, seats } : room;
}

function shuffleDeck(seed: string): Card[] {
	const SUITS: Card['suit'][] = ['hearts', 'diamonds', 'clubs', 'spades'];
	const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
	const deck: Card[] = [];
	for (const suit of SUITS) {
		for (let i = 0; i < VALUES.length; i++) {
			deck.push({ value: VALUES[i], suit, rank: i + 2 });
		}
	}
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = h ^ 0x9e3779b9;
	let b = h ^ 0x243f6a88;
	let c = h ^ 0xb7e15162;
	let d = h ^ 0xdeadbeef;
	const rng = () => {
		const t = (a + b) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		d = (d + 1) | 0;
		const r = (t + d) | 0;
		return (r >>> 0) / 4294967296;
	};
	for (let i = deck.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

function cloneSeatWithChips(seat: SeatState, chips: number): SeatState {
	return { ...seat, chips };
}

export function startHand(room: Room, args: { deckSeed: string; starterUserId: string }): Room {
	if (room.phase === 'in-hand') {
		throw new EngineError('INVALID_PHASE', 'cannot start hand while room is in-hand');
	}
	const starter = room.seats.find((seat) => seat.userId === args.starterUserId);
	if (!starter || !starter.connected || starter.chips < room.config.bigBlind) {
		throw new EngineError(
			'INVALID_ACTION',
			'only a connected seated player with enough chips may start a hand',
		);
	}
	const eligible = room.seats.filter(
		(seat) => seat.userId !== null && seat.connected && seat.chips >= room.config.bigBlind,
	);
	if (eligible.length < 2) {
		throw new EngineError(
			'NOT_ENOUGH_PLAYERS',
			'need at least 2 connected players with enough chips',
		);
	}

	const deck = shuffleDeck(args.deckSeed);
	const holeCards: Record<string, Card[]> = {};
	const committed: Record<string, number> = {};
	let cursor = 0;
	for (const seat of eligible) {
		holeCards[seat.userId!] = [deck[cursor], deck[cursor + 1]];
		cursor += 2;
		committed[seat.userId!] = 0;
	}

	const eligibleIndices = eligible.map((seat) => seat.seatIndex).sort((a, b) => a - b);
	const dealerSeat =
		eligibleIndices.find((index) => index > room.lastDealerSeat) ?? eligibleIndices[0];
	let sbSeat: number;
	let bbSeat: number;
	if (eligibleIndices.length === 2) {
		sbSeat = dealerSeat;
		bbSeat = eligibleIndices.find((index) => index !== dealerSeat)!;
	} else {
		const dealerPos = eligibleIndices.indexOf(dealerSeat);
		sbSeat = eligibleIndices[(dealerPos + 1) % eligibleIndices.length];
		bbSeat = eligibleIndices[(dealerPos + 2) % eligibleIndices.length];
	}

	const sbUser = room.seats[sbSeat].userId!;
	const bbUser = room.seats[bbSeat].userId!;
	const seats = room.seats.map((seat) => ({ ...seat }));
	const postBlind = (userId: string, blind: number): void => {
		const seatIndex = seats.findIndex((seat) => seat.userId === userId);
		const seat = seats[seatIndex];
		const paid = Math.min(blind, seat.chips);
		seats[seatIndex] = cloneSeatWithChips(seat, seat.chips - paid);
		committed[userId] = paid;
	};
	postBlind(sbUser, room.config.smallBlind);
	postBlind(bbUser, room.config.bigBlind);

	let currentSeat: number;
	if (eligibleIndices.length === 2) {
		currentSeat = sbSeat;
	} else {
		const bbPos = eligibleIndices.indexOf(bbSeat);
		currentSeat = eligibleIndices[(bbPos + 1) % eligibleIndices.length];
	}
	const allIn = new Set<string>(
		Object.keys(committed).filter((userId) => {
			const seat = seats.find((candidate) => candidate.userId === userId)!;
			return seat.chips === 0;
		}),
	);

	const hand: HandState = {
		bettingRound: 'preflop',
		dealerSeat,
		currentSeat,
		deck: deck.slice(cursor),
		board: [],
		holeCards,
		committed,
		currentBet: room.config.bigBlind,
		lastRaiseAmount: room.config.bigBlind,
		folded: new Set(),
		allIn,
		hasActed: new Set(),
		seatIndexMap: Object.fromEntries(eligible.map((seat) => [seat.userId!, seat.seatIndex])),
	};

	return { ...room, phase: 'in-hand', seats, hand, lastDealerSeat: dealerSeat };
}

export type ActionInput =
	| { action: 'fold' }
	| { action: 'check' }
	| { action: 'call' }
	| { action: 'bet'; amount: number }
	| { action: 'raise'; amount: number }
	| { action: 'all_in' };

function noTransition(room: Room): RoomTransition {
	return { room, handResult: null };
}

function userAtSeat(hand: HandState, seatIndex: number): string | null {
	for (const [userId, index] of Object.entries(hand.seatIndexMap)) {
		if (index === seatIndex) return userId;
	}
	return null;
}

export function forceFold(room: Room, userId: string): RoomTransition {
	if (room.phase !== 'in-hand' || !room.hand) return noTransition(room);
	const hand = room.hand;
	if (!hand.holeCards[userId] || hand.folded.has(userId)) return noTransition(room);

	const folded = new Set(hand.folded);
	folded.add(userId);
	const remainingUserIds = Object.keys(hand.holeCards).filter((id) => !folded.has(id));
	const updatedRoom = { ...room, hand: { ...hand, folded } };
	if (remainingUserIds.length <= 1) return finishHand(updatedRoom, 'fold-out');
	return noTransition(updatedRoom);
}

export function applyAction(room: Room, userId: string, input: ActionInput): RoomTransition {
	if (room.phase !== 'in-hand' || !room.hand) {
		throw new EngineError('INVALID_ACTION', 'not in hand');
	}
	const hand = room.hand;
	const seat = room.seats[hand.currentSeat];
	if (seat?.userId !== userId) {
		throw new EngineError('NOT_YOUR_TURN', 'not your turn');
	}

	const stack = seat.chips;
	const committedNow = hand.committed[userId] ?? 0;
	const remaining = stack;
	const toCall = hand.currentBet - committedNow;
	const alreadyActed = hand.hasActed.has(userId);
	const allInIsCall = input.action === 'all_in' && remaining <= toCall;
	if (
		alreadyActed &&
		toCall > 0 &&
		(input.action === 'raise' || input.action === 'bet' || input.action === 'all_in') &&
		!allInIsCall
	) {
		throw new EngineError(
			'INVALID_ACTION',
			'cannot raise; action not reopened — call or fold only',
		);
	}

	const committed = { ...hand.committed };
	const folded = new Set(hand.folded);
	const allIn = new Set(hand.allIn);
	const hasActed = new Set(hand.hasActed);
	let currentBet = hand.currentBet;
	let lastRaiseAmount = hand.lastRaiseAmount;
	let paid = 0;

	switch (input.action) {
		case 'fold':
			folded.add(userId);
			break;
		case 'check':
			if (toCall > 0) throw new EngineError('INVALID_ACTION', 'cannot check facing a bet');
			break;
		case 'call': {
			if (toCall <= 0) throw new EngineError('INVALID_ACTION', 'nothing to call');
			paid = Math.min(toCall, remaining);
			committed[userId] = committedNow + paid;
			if (paid === remaining) allIn.add(userId);
			break;
		}
		case 'bet':
		case 'raise': {
			const target = input.amount;
			if (target <= hand.currentBet) {
				throw new EngineError('INVALID_ACTION', 'raise must exceed current bet');
			}
			if (target <= committedNow) {
				throw new EngineError('INVALID_ACTION', 'raise must exceed current commitment');
			}
			const minRaise = hand.currentBet + hand.lastRaiseAmount;
			if (target < minRaise && target - committedNow < remaining) {
				throw new EngineError('INVALID_ACTION', 'raise below min-raise');
			}
			paid = Math.min(target - committedNow, remaining);
			committed[userId] = committedNow + paid;
			if (paid === remaining) allIn.add(userId);
			const raiseIncrement = committed[userId] - hand.currentBet;
			if (raiseIncrement >= hand.lastRaiseAmount) {
				lastRaiseAmount = raiseIncrement;
				currentBet = committed[userId];
				for (const id of Object.keys(hand.holeCards)) {
					if (id !== userId && !folded.has(id) && !allIn.has(id)) hasActed.delete(id);
				}
			} else {
				currentBet = Math.max(currentBet, committed[userId]);
			}
			break;
		}
		case 'all_in': {
			paid = remaining;
			committed[userId] = committedNow + paid;
			allIn.add(userId);
			if (committed[userId] > hand.currentBet) {
				const raiseIncrement = committed[userId] - hand.currentBet;
				if (raiseIncrement >= hand.lastRaiseAmount) {
					lastRaiseAmount = raiseIncrement;
					currentBet = committed[userId];
					for (const id of Object.keys(hand.holeCards)) {
						if (id !== userId && !folded.has(id) && !allIn.has(id)) hasActed.delete(id);
					}
				} else {
					currentBet = Math.max(currentBet, committed[userId]);
				}
			}
			break;
		}
	}

	hasActed.add(userId);
	const seats = room.seats.map((candidate) =>
		candidate.userId === userId ? cloneSeatWithChips(candidate, candidate.chips - paid) : candidate,
	);
	const updatedHand: HandState = {
		...hand,
		committed,
		folded,
		allIn,
		hasActed,
		currentBet,
		lastRaiseAmount,
	};
	const updatedRoom = { ...room, seats, hand: updatedHand };

	const remainingUserIds = Object.keys(hand.holeCards).filter((id) => !folded.has(id));
	if (remainingUserIds.length === 1) return finishHand(updatedRoom, 'fold-out');

	const stillToAct = Object.keys(hand.holeCards).filter(
		(id) => !folded.has(id) && !allIn.has(id) && (!hasActed.has(id) || committed[id] < currentBet),
	);
	if (stillToAct.length === 0) return advanceRound(updatedRoom);

	const nextSeat = nextActiveSeat(updatedRoom, updatedHand);
	return noTransition({ ...updatedRoom, hand: { ...updatedHand, currentSeat: nextSeat } });
}

function nextActiveSeat(room: Room, hand: HandState): number {
	const n = room.seats.length;
	let index = hand.currentSeat;
	for (let step = 0; step < n; step++) {
		index = (index + 1) % n;
		const userId = userAtSeat(hand, index);
		if (userId && !hand.folded.has(userId) && !hand.allIn.has(userId)) return index;
	}
	return hand.currentSeat;
}

function advanceRound(room: Room): RoomTransition {
	const hand = room.hand!;
	let board = hand.board;
	let nextRound: HandState['bettingRound'];
	let deck = hand.deck;
	switch (hand.bettingRound) {
		case 'preflop':
			board = [...board, deck[0], deck[1], deck[2]];
			deck = deck.slice(3);
			nextRound = 'flop';
			break;
		case 'flop':
			board = [...board, deck[0]];
			deck = deck.slice(1);
			nextRound = 'turn';
			break;
		case 'turn':
			board = [...board, deck[0]];
			deck = deck.slice(1);
			nextRound = 'river';
			break;
		case 'river':
			return finishHand(room, 'showdown');
		default:
			return noTransition(room);
	}

	const eligibleUserIds = Object.keys(hand.holeCards).filter(
		(userId) => !hand.folded.has(userId) && !hand.allIn.has(userId),
	);
	if (eligibleUserIds.length < 2) {
		return advanceRound({
			...room,
			hand: { ...hand, board, deck, bettingRound: nextRound },
		});
	}

	const eligibleIndices = eligibleUserIds
		.map((userId) => hand.seatIndexMap[userId])
		.sort((a, b) => a - b);
	const firstSeat = eligibleIndices.find((index) => index > hand.dealerSeat) ?? eligibleIndices[0];
	const maxCommitted = Math.max(...eligibleUserIds.map((userId) => hand.committed[userId] ?? 0));
	return noTransition({
		...room,
		hand: {
			...hand,
			board,
			deck,
			bettingRound: nextRound,
			currentBet: maxCommitted,
			lastRaiseAmount: room.config.bigBlind,
			hasActed: new Set(),
			currentSeat: firstSeat,
		},
	});
}

function makeShowdownPlayer(userId: string, hand: HandState): Player {
	const seatIndex = hand.seatIndexMap[userId];
	return {
		id: seatIndex,
		name: userId,
		chips: 0,
		hand: hand.holeCards[userId],
		currentBet: 0,
		totalBet: hand.committed[userId] ?? 0,
		folded: false,
		isAllIn: hand.allIn.has(userId),
		isDealer: seatIndex === hand.dealerSeat,
		isAI: false,
		hasActed: true,
	};
}

export interface PotResult {
	amount: number;
	eligibleSeatIndices: number[];
}

export function buildSidePots(hand: HandState): PotResult[] {
	const dealtUserIds = Object.keys(hand.holeCards);
	if (dealtUserIds.length === 0) return [];
	const levels = [...new Set(Object.values(hand.committed))].sort((a, b) => a - b);
	if (levels.length === 0) return [];

	const pots: PotResult[] = [];
	let previousLevel = 0;
	for (const level of levels) {
		if (level <= previousLevel) continue;
		const contributors = dealtUserIds.filter((userId) => (hand.committed[userId] ?? 0) >= level);
		const eligible = contributors.filter((userId) => !hand.folded.has(userId));
		if (eligible.length > 0) {
			pots.push({
				amount: (level - previousLevel) * contributors.length,
				eligibleSeatIndices: eligible.map((userId) => hand.seatIndexMap[userId]),
			});
		}
		previousLevel = level;
	}
	return pots;
}

function completeHand(
	room: Room,
	winners: HandWinner[],
	showdownCards: ShowdownCard[],
): RoomTransition {
	const awardByUserId = new Map(winners.map((winner) => [winner.userId, winner]));
	const seats = room.seats.map((seat) => {
		if (!seat.userId) return seat;
		const winner = awardByUserId.get(seat.userId);
		if (!winner || winner.seatIndex !== seat.seatIndex) return seat;
		return { ...seat, chips: seat.chips + winner.amount };
	});
	return {
		room: { ...room, phase: 'waiting', seats, hand: null },
		handResult: { winners, showdownCards },
	};
}

function finishHand(room: Room, reason: 'fold-out' | 'showdown'): RoomTransition {
	const hand = room.hand!;
	const remainingUserIds = Object.keys(hand.holeCards).filter((userId) => !hand.folded.has(userId));
	if (remainingUserIds.length === 0) return noTransition(room);

	if (reason === 'fold-out' || remainingUserIds.length === 1) {
		const userId = remainingUserIds[0];
		return completeHand(
			room,
			[
				{
					userId,
					seatIndex: hand.seatIndexMap[userId],
					amount: Object.values(hand.committed).reduce((sum, value) => sum + value, 0),
				},
			],
			[],
		);
	}

	const pots = buildSidePots(hand);
	const winnings = new Map<string, number>();
	const numSeats = room.seats.length;
	for (const pot of pots) {
		const eligibleUserIds = pot.eligibleSeatIndices
			.map((seatIndex) => userAtSeat(hand, seatIndex))
			.filter((userId): userId is string => userId !== null);
		const eligiblePlayers = eligibleUserIds.map((userId) => makeShowdownPlayer(userId, hand));
		const potWinners = determineShowdownWinners(eligiblePlayers, hand.board);
		if (potWinners.length === 0) continue;
		const split = Math.floor(pot.amount / potWinners.length);
		const remainder = pot.amount - split * potWinners.length;
		const sortedForOddChip = [...potWinners].sort((a, b) => {
			const rawA = (a.id - hand.dealerSeat + numSeats) % numSeats;
			const rawB = (b.id - hand.dealerSeat + numSeats) % numSeats;
			const distanceA = rawA === 0 ? numSeats : rawA;
			const distanceB = rawB === 0 ? numSeats : rawB;
			return distanceA - distanceB;
		});
		for (let index = 0; index < sortedForOddChip.length; index++) {
			const winner = sortedForOddChip[index];
			const userId = winner.name;
			winnings.set(userId, (winnings.get(userId) ?? 0) + split + (index < remainder ? 1 : 0));
		}
	}

	const winners = Array.from(winnings.entries()).map(([userId, amount]) => ({
		userId,
		seatIndex: hand.seatIndexMap[userId],
		amount,
	}));
	const showdownCards = remainingUserIds.map((userId) => ({
		userId,
		seatIndex: hand.seatIndexMap[userId],
		cards: hand.holeCards[userId] as [Card, Card],
	}));
	return completeHand(room, winners, showdownCards);
}
