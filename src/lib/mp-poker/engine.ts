import type { Card, Player } from '../poker/types';
import { determineShowdownWinners } from '../poker/handEvaluator';

export interface RoomConfig {
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
	hostUserId: string;
}

export interface SeatState {
	seatIndex: number;
	userId: string | null;
	displayName: string | null;
	mainBalance: number;
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
	handStacks: Record<string, number>;
	/** Immutable userId → seatIndex mapping captured at deal time.
	 *  Survives seat clearing (e.g. disconnect eviction) so
	 *  buildSidePots always resolves winners correctly. */
	seatIndexMap: Record<string, number>;
}

export interface HandLogEntry {
	endedAt: number;
	winners: { seatIndex: number; amount: number }[];
}

export interface Room {
	config: RoomConfig;
	phase: 'idle' | 'seating' | 'in-hand' | 'settling' | 'frozen';
	seats: SeatState[];
	hand: HandState | null;
	handLog: HandLogEntry[];
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

export function createRoom(config: RoomConfig): Room {
	if (config.maxSeats < 2 || config.maxSeats > 6) {
		throw new EngineError('INVALID_CONFIG', 'maxSeats must be 2-6');
	}
	const seats: SeatState[] = [];
	for (let i = 0; i < config.maxSeats; i++) {
		seats.push({
			seatIndex: i,
			userId: null,
			displayName: null,
			mainBalance: 0,
			connected: false,
			disconnectedAt: null,
		});
	}
	return { config, phase: 'idle', seats, hand: null, handLog: [], lastDealerSeat: -1 };
}

export function takeSeat(
	room: Room,
	args: { userId: string; displayName: string; seatIndex: number; mainBalance: number },
): Room {
	if (room.phase === 'in-hand' || room.phase === 'frozen' || room.phase === 'settling') {
		throw new EngineError('INVALID_PHASE', 'cannot take seat during active hand');
	}
	const { userId, displayName, seatIndex, mainBalance } = args;
	if (seatIndex < 0 || seatIndex >= room.seats.length) {
		throw new EngineError('INVALID_SEAT', 'seat out of range');
	}
	if (room.seats[seatIndex].userId !== null) {
		throw new EngineError('INVALID_SEAT', 'seat occupied');
	}
	if (room.seats.some((s) => s.userId === userId)) {
		throw new EngineError('INVALID_SEAT', 'user already seated');
	}
	const seats = room.seats.map((s, i) =>
		i === seatIndex
			? { ...s, userId, displayName, mainBalance, connected: true, disconnectedAt: null }
			: s,
	);
	return { ...room, phase: 'seating', seats };
}

export function leaveSeat(room: Room, userId: string): Room {
	if (room.phase === 'in-hand') {
		throw new EngineError('INVALID_PHASE', 'cannot leave seat during active hand; fold instead');
	}
	const seats = room.seats.map((s) =>
		s.userId === userId
			? { ...s, userId: null, displayName: null, connected: false, disconnectedAt: null }
			: s,
	);
	const anyOccupied = seats.some((s) => s.userId !== null);
	// Preserve frozen/settling phase even when all seats empty — prevents bypassing
	// the freeze that protects an unresolved settlement.
	const nextPhase =
		anyOccupied || room.phase === 'frozen' || room.phase === 'settling' ? room.phase : 'idle';
	return {
		...room,
		phase: nextPhase,
		seats,
	};
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

export function startHand(
	room: Room,
	args: { snapshots: Record<string, number>; deckSeed: string },
): Room {
	if (room.phase === 'in-hand' || room.phase === 'frozen') {
		throw new EngineError('INVALID_PHASE', 'cannot start hand while room is in-hand or frozen');
	}
	const seated = room.seats.filter((s) => s.userId !== null);
	if (seated.length < 2) {
		throw new EngineError('NOT_ENOUGH_PLAYERS', 'need at least 2 seated players');
	}
	const eligible = seated.filter((s) => (args.snapshots[s.userId!] ?? 0) >= room.config.bigBlind);
	if (eligible.length < 2) {
		throw new EngineError('NOT_ENOUGH_PLAYERS', 'fewer than 2 players can post big blind');
	}

	const deck = shuffleDeck(args.deckSeed);
	const holeCards: Record<string, Card[]> = {};
	const handStacks: Record<string, number> = {};
	const committed: Record<string, number> = {};

	let cursor = 0;
	for (const seat of eligible) {
		holeCards[seat.userId!] = [deck[cursor], deck[cursor + 1]];
		cursor += 2;
		handStacks[seat.userId!] = args.snapshots[seat.userId!];
		committed[seat.userId!] = 0;
	}

	const lastDealerIndex = room.lastDealerSeat;
	const eligibleIndices = eligible.map((s) => s.seatIndex).sort((a, b) => a - b);
	const dealerSeat = eligibleIndices.find((i) => i > lastDealerIndex) ?? eligibleIndices[0];

	let sbSeat: number;
	let bbSeat: number;
	if (eligibleIndices.length === 2) {
		sbSeat = dealerSeat;
		bbSeat = eligibleIndices.find((i) => i !== dealerSeat)!;
	} else {
		const dealerPos = eligibleIndices.indexOf(dealerSeat);
		sbSeat = eligibleIndices[(dealerPos + 1) % eligibleIndices.length];
		bbSeat = eligibleIndices[(dealerPos + 2) % eligibleIndices.length];
	}
	const sbUser = room.seats[sbSeat].userId!;
	const bbUser = room.seats[bbSeat].userId!;
	committed[sbUser] = Math.min(room.config.smallBlind, handStacks[sbUser]);
	committed[bbUser] = Math.min(room.config.bigBlind, handStacks[bbUser]);

	let currentSeat: number;
	if (eligibleIndices.length === 2) {
		currentSeat = sbSeat;
	} else {
		const bbPos = eligibleIndices.indexOf(bbSeat);
		currentSeat = eligibleIndices[(bbPos + 1) % eligibleIndices.length];
	}

	const allIn = new Set<string>(
		Object.entries(committed)
			.filter(([uid, c]) => c >= handStacks[uid])
			.map(([uid]) => uid),
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
		handStacks,
		seatIndexMap: Object.fromEntries(eligible.map((s) => [s.userId!, s.seatIndex])),
	};

	return { ...room, phase: 'in-hand', hand, lastDealerSeat: dealerSeat };
}

export type ActionInput =
	| { action: 'fold' }
	| { action: 'check' }
	| { action: 'call' }
	| { action: 'bet'; amount: number }
	| { action: 'raise'; amount: number }
	| { action: 'all_in' };

/**
 * Force-fold a player without advancing the turn cursor.
 * Used for disconnect timeouts where the folded player may not be the current actor.
 * If the fold leaves only one player, the hand finishes via fold-out.
 */
export function forceFold(room: Room, userId: string): Room {
	if (room.phase !== 'in-hand' || !room.hand) {
		return room;
	}
	const hand = room.hand;
	if (!hand.holeCards[userId] || hand.folded.has(userId)) {
		return room;
	}

	const newFolded = new Set(hand.folded);
	newFolded.add(userId);

	const remaining = room.seats.filter(
		(s) => s.userId && hand.holeCards[s.userId] && !newFolded.has(s.userId),
	);

	if (remaining.length <= 1) {
		return finishHand({ ...room, hand: { ...hand, folded: newFolded } }, 'fold-out');
	}

	return { ...room, hand: { ...hand, folded: newFolded } };
}

export function applyAction(room: Room, userId: string, input: ActionInput): Room {
	if (room.phase !== 'in-hand' || !room.hand) {
		throw new EngineError('INVALID_ACTION', 'not in hand');
	}
	const hand = room.hand;
	const seat = room.seats[hand.currentSeat];
	if (seat.userId !== userId) {
		throw new EngineError('NOT_YOUR_TURN', 'not your turn');
	}

	const stack = hand.handStacks[userId];
	const committedNow = hand.committed[userId];
	const remaining = stack - committedNow;
	const toCall = hand.currentBet - committedNow;

	// A player who has already acted in this betting round may only call or
	// fold when facing a short all-in that did not reopen the action.
	// After a full raise, hasActed is cleared for affected players, so this
	// guard does not block legitimate re-raises.
	// Exception: all_in with remaining <= toCall is a call, not a raise —
	// the player is simply putting in their last chips to match the bet.
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

	const newCommitted = { ...hand.committed };
	const newFolded = new Set(hand.folded);
	const newAllIn = new Set(hand.allIn);
	const newHasActed = new Set(hand.hasActed);
	let newBet = hand.currentBet;
	let newLastRaise = hand.lastRaiseAmount;

	switch (input.action) {
		case 'fold':
			newFolded.add(userId);
			break;
		case 'check':
			if (toCall > 0) throw new EngineError('INVALID_ACTION', 'cannot check facing a bet');
			break;
		case 'call': {
			if (toCall <= 0) throw new EngineError('INVALID_ACTION', 'nothing to call');
			const pay = Math.min(toCall, remaining);
			newCommitted[userId] = committedNow + pay;
			if (pay === remaining) newAllIn.add(userId);
			break;
		}
		case 'bet':
		case 'raise': {
			const target = input.amount;
			if (target <= hand.currentBet)
				throw new EngineError('INVALID_ACTION', 'raise must exceed current bet');
			if (target <= committedNow)
				throw new EngineError('INVALID_ACTION', 'raise must exceed current commitment');
			const minRaise = hand.currentBet + hand.lastRaiseAmount;
			if (target < minRaise && target - committedNow < remaining)
				throw new EngineError('INVALID_ACTION', 'raise below min-raise');
			const pay = Math.min(target - committedNow, remaining);
			newCommitted[userId] = committedNow + pay;
			if (pay === remaining) newAllIn.add(userId);
			const raiseIncrement = newCommitted[userId] - hand.currentBet;
			// Only update lastRaiseAmount and reopen action for full raises
			if (raiseIncrement >= hand.lastRaiseAmount) {
				newLastRaise = raiseIncrement;
				newBet = newCommitted[userId];
				for (const s of room.seats) {
					if (
						s.userId &&
						s.userId !== userId &&
						!newFolded.has(s.userId) &&
						!newAllIn.has(s.userId)
					) {
						newHasActed.delete(s.userId);
					}
				}
			} else {
				// Short all-in raise: update currentBet but preserve lastRaiseAmount
				newBet = Math.max(newBet, newCommitted[userId]);
			}
			break;
		}
		case 'all_in': {
			const pay = remaining;
			newCommitted[userId] = committedNow + pay;
			newAllIn.add(userId);
			if (newCommitted[userId] > hand.currentBet) {
				const raiseIncrement = newCommitted[userId] - hand.currentBet;
				// Only update lastRaiseAmount and reopen action for full raises
				if (raiseIncrement >= hand.lastRaiseAmount) {
					newLastRaise = raiseIncrement;
					newBet = newCommitted[userId];
					for (const s of room.seats) {
						if (
							s.userId &&
							s.userId !== userId &&
							!newFolded.has(s.userId) &&
							!newAllIn.has(s.userId)
						) {
							newHasActed.delete(s.userId);
						}
					}
				} else {
					// Short all-in: update currentBet but preserve lastRaiseAmount
					newBet = Math.max(newBet, newCommitted[userId]);
				}
			}
			break;
		}
	}
	newHasActed.add(userId);

	const updatedHand: HandState = {
		...hand,
		committed: newCommitted,
		folded: newFolded,
		allIn: newAllIn,
		hasActed: newHasActed,
		currentBet: newBet,
		lastRaiseAmount: newLastRaise,
	};

	const remainingSeats = room.seats.filter(
		(s) => s.userId && hand.holeCards[s.userId] && !newFolded.has(s.userId),
	);
	if (remainingSeats.length === 1) {
		return finishHand({ ...room, hand: updatedHand }, 'fold-out');
	}

	const stillToAct = room.seats.filter(
		(s) =>
			s.userId &&
			hand.holeCards[s.userId] &&
			!newFolded.has(s.userId) &&
			!newAllIn.has(s.userId) &&
			(!newHasActed.has(s.userId) || newCommitted[s.userId] < newBet),
	);
	if (stillToAct.length === 0) {
		return advanceRound({ ...room, hand: updatedHand });
	}

	const nextSeat = nextActiveSeat(room, updatedHand);
	return { ...room, hand: { ...updatedHand, currentSeat: nextSeat } };
}

function nextActiveSeat(room: Room, hand: HandState): number {
	const n = room.seats.length;
	let i = hand.currentSeat;
	for (let step = 0; step < n; step++) {
		i = (i + 1) % n;
		const s = room.seats[i];
		if (
			s.userId &&
			hand.holeCards[s.userId] &&
			!hand.folded.has(s.userId) &&
			!hand.allIn.has(s.userId)
		) {
			return i;
		}
	}
	return hand.currentSeat;
}

function advanceRound(room: Room): Room {
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
			return room;
	}
	const eligibleIndices = room.seats
		.filter(
			(s) =>
				s.userId &&
				hand.holeCards[s.userId] &&
				!hand.folded.has(s.userId) &&
				!hand.allIn.has(s.userId),
		)
		.map((s) => s.seatIndex)
		.sort((a, b) => a - b);
	if (eligibleIndices.length < 2) {
		// Fewer than 2 players can act (all-in or heads-up with one all-in):
		// fast-forward through remaining streets to showdown
		return advanceRound({
			...room,
			hand: { ...hand, board, deck, bettingRound: nextRound },
		});
	}
	const firstSeat = eligibleIndices.find((i) => i > hand.dealerSeat) ?? eligibleIndices[0];
	// Keep currentBet aligned with cumulative commitments so that raiseIncrement
	// (= newCommitted - currentBet) measures the actual chip increase, not the
	// total committed.  Using maxCommitted means toCall = 0 for every eligible
	// player (they can check), while min-raise is correctly computed as
	// maxCommitted + lastRaiseAmount.
	const eligibleUserIds = eligibleIndices.map((i) => room.seats[i].userId!);
	const maxCommitted = Math.max(...eligibleUserIds.map((uid) => hand.committed[uid] ?? 0));
	return {
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
	};
}

function makeShowdownPlayer(seatIndex: number, userId: string, hand: HandState): Player {
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

interface PotResult {
	amount: number;
	eligibleSeatIndices: number[];
}

/**
 * Build side pots from committed amounts. Standard algorithm:
 * 1. Sort all-in/eligible commitment levels ascending
 * 2. For each level, the pot is (level - prevLevel) × count of players who contributed at least that much
 * 3. Only non-folded players who contributed to a pot level are eligible to win it
 *
 * Uses hand.seatIndexMap (captured at deal time) for userId → seatIndex resolution,
 * so it remains correct even if seats are cleared (e.g. disconnect eviction).
 */
export function buildSidePots(hand: HandState, _seats: SeatState[]): PotResult[] {
	// All players who were dealt into the hand — use holeCards as source of truth
	const dealtUserIds = Object.keys(hand.holeCards);
	if (dealtUserIds.length === 0) return [];

	// Use the immutable seatIndexMap captured at deal time instead of scanning
	// live seats (which may have userId cleared after disconnect eviction).
	const seatIndexMap = hand.seatIndexMap;

	// Get sorted unique commitment levels (only levels where at least one player is all-in or folded)
	const committed = hand.committed;
	const levels = [...new Set(Object.values(committed))].sort((a, b) => a - b);
	if (levels.length === 0) return [];

	const pots: PotResult[] = [];
	let prevLevel = 0;

	for (const level of levels) {
		if (level <= prevLevel) continue;

		// Players who contributed at least `level` chips
		const contributors = dealtUserIds.filter((uid) => (committed[uid] ?? 0) >= level);
		// Only non-folded players can win
		const eligible = contributors.filter((uid) => !hand.folded.has(uid));
		if (eligible.length === 0) {
			// If all eligible folded, the pot goes to the last remaining player(s) — handled by fold-out
			prevLevel = level;
			continue;
		}

		const potAmount = (level - prevLevel) * contributors.length;
		pots.push({
			amount: potAmount,
			eligibleSeatIndices: eligible.map((uid) => seatIndexMap[uid] ?? -1),
		});
		prevLevel = level;
	}

	return pots;
}

function finishHand(room: Room, reason: 'fold-out' | 'showdown'): Room {
	const hand = room.hand!;
	const remaining = room.seats.filter(
		(s) => s.userId && hand.holeCards[s.userId] && !hand.folded.has(s.userId),
	);

	let winners: { seatIndex: number; amount: number }[];

	if (reason === 'fold-out' || remaining.length === 1) {
		// Fold-out: single remaining player wins everything
		const totalPot = Object.values(hand.committed).reduce((a, b) => a + b, 0);
		winners = [{ seatIndex: remaining[0].seatIndex, amount: totalPot }];
	} else {
		// Showdown with side pots
		const pots = buildSidePots(hand, room.seats);
		const winMap = new Map<number, number>();

		for (const pot of pots) {
			const eligiblePlayers = pot.eligibleSeatIndices
				.map((si) => {
					const seat = room.seats[si];
					return seat.userId ? makeShowdownPlayer(si, seat.userId, hand) : null;
				})
				.filter((p): p is Player => p !== null);

			const potWinners = determineShowdownWinners(eligiblePlayers, hand.board);
			const split = Math.floor(pot.amount / potWinners.length);
			const remainder = pot.amount - split * potWinners.length;
			// Sort winners by clockwise distance from dealer for odd-chip distribution.
			// Standard poker rule: odd chips go to the player closest LEFT of the dealer
			// (first clockwise after the button), with the dealer themselves receiving last.
			const numSeats = room.seats.length;
			const sortedForOddChip = [...potWinners].sort((a, b) => {
				const rawA = (a.id - hand.dealerSeat + numSeats) % numSeats;
				const rawB = (b.id - hand.dealerSeat + numSeats) % numSeats;
				const distA = rawA === 0 ? numSeats : rawA;
				const distB = rawB === 0 ? numSeats : rawB;
				return distA - distB;
			});
			for (let i = 0; i < potWinners.length; i++) {
				const extra = i < remainder ? 1 : 0;
				winMap.set(
					sortedForOddChip[i].id,
					(winMap.get(sortedForOddChip[i].id) ?? 0) + split + extra,
				);
			}
		}

		winners = Array.from(winMap.entries()).map(([seatIndex, amount]) => ({
			seatIndex,
			amount,
		}));
	}

	const newLog = [...room.handLog, { endedAt: Date.now(), winners }].slice(-20);

	return {
		...room,
		phase: 'settling',
		hand: { ...hand, bettingRound: 'showdown' },
		handLog: newLog,
	};
}
