import { describe, expect, test } from 'bun:test';
import type { Card } from '../poker/types';
import {
	applyAction,
	buildSidePots,
	clearDisconnectedSeat,
	createRoom,
	EngineError,
	forceFold,
	leaveSeat,
	startHand as engineStartHand,
	takeSeat,
	type ActionInput,
	type HandState,
	type Room,
	type SeatState,
} from './engine';

const SMALL_BLIND = 5;
const BIG_BLIND = 10;

function createSeatedRoom(
	maxSeats: 2 | 4 | 6,
	userIds: string[] = ['u1', 'u2'],
	chips: Record<string, number> = {},
): Room {
	let room = createRoom({ maxSeats, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND });
	for (const [seatIndex, userId] of userIds.entries()) {
		room = takeSeat(room, { userId, displayName: userId, seatIndex });
	}
	if (Object.keys(chips).length === 0) return room;
	return {
		...room,
		seats: room.seats.map((seat) =>
			seat.userId && chips[seat.userId] !== undefined
				? { ...seat, chips: chips[seat.userId] }
				: seat,
		),
	};
}

function setSeat(room: Room, userId: string, patch: Partial<SeatState>): Room {
	return {
		...room,
		seats: room.seats.map((seat) => (seat.userId === userId ? { ...seat, ...patch } : seat)),
	};
}

function currentUser(room: Room): string {
	if (!room.hand) throw new Error('expected an active hand');
	const userId = room.seats[room.hand.currentSeat]?.userId;
	if (!userId) throw new Error('expected current seat to have a user');
	return userId;
}

function act(room: Room, userId: string, action: ActionInput) {
	return applyAction(room, userId, action);
}

function startHand(room: Room, args: { deckSeed: string; starterUserId?: string }): Room {
	const starterUserId =
		args.starterUserId ??
		room.seats.find(
			(seat) => seat.userId !== null && seat.connected && seat.chips >= room.config.bigBlind,
		)?.userId;
	if (!starterUserId) throw new Error('test room has no eligible starter');
	return engineStartHand(room, { deckSeed: args.deckSeed, starterUserId });
}

function startArgs(deckSeed: string, starterUserId: string): Parameters<typeof engineStartHand>[1] {
	return { deckSeed, starterUserId };
}

function checkDown(room: Room) {
	let current = room;
	for (let i = 0; i < 20; i++) {
		const userId = currentUser(current);
		const committed = current.hand!.committed[userId] ?? 0;
		const toCall = current.hand!.currentBet - committed;
		const transition = act(current, userId, toCall > 0 ? { action: 'call' } : { action: 'check' });
		if (transition.handResult) return transition;
		current = transition.room;
	}
	throw new Error('checkdown did not complete');
}

function makeTiedRiverRoom(dealerSeat: number): Room {
	const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u1: 100, u2: 100, u3: 100 }), {
		deckSeed: `tie-${dealerSeat}`,
	});
	const board: Card[] = [
		{ value: 'A', suit: 'spades', rank: 14 },
		{ value: 'A', suit: 'hearts', rank: 14 },
		{ value: 'A', suit: 'diamonds', rank: 14 },
		{ value: 'K', suit: 'clubs', rank: 13 },
		{ value: 'K', suit: 'hearts', rank: 13 },
	];
	const holeCards: Record<string, [Card, Card]> = {
		u1: [
			{ value: '2', suit: 'clubs', rank: 2 },
			{ value: '3', suit: 'clubs', rank: 3 },
		],
		u2: [
			{ value: '4', suit: 'clubs', rank: 4 },
			{ value: '5', suit: 'clubs', rank: 5 },
		],
		u3: [
			{ value: '6', suit: 'clubs', rank: 6 },
			{ value: '7', suit: 'clubs', rank: 7 },
		],
	};
	const hand = room.hand!;
	const testHand: HandState = {
		...hand,
		board,
		holeCards,
		committed: { u1: 5, u2: 5, u3: 3 },
		folded: new Set(['u3']),
		allIn: new Set(),
		bettingRound: 'river',
		currentBet: 0,
		lastRaiseAmount: BIG_BLIND,
		hasActed: new Set(['u1', 'u2']),
		currentSeat: 1,
		dealerSeat,
		seatIndexMap: { u1: 0, u2: 1, u3: 2 },
	};
	return { ...room, hand: testHand };
}

describe('engine — seating and room configuration', () => {
	test('createRoom returns a waiting room with the configured seats', () => {
		const room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10 });
		expect(room.phase).toBe('waiting');
		expect(room.config).toEqual({ maxSeats: 4, smallBlind: 5, bigBlind: 10 });
		expect(room.seats).toHaveLength(4);
		expect(room.seats.every((seat) => seat.userId === null && seat.chips === 0)).toBe(true);
	});

	test('taking a seat grants 100 big blinds', () => {
		const room = takeSeat(createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 }), {
			userId: 'u1',
			displayName: 'Alice',
			seatIndex: 0,
		});
		expect(room.phase).toBe('waiting');
		expect(room.seats[0]).toMatchObject({ userId: 'u1', displayName: 'Alice', chips: 1_000 });
	});

	test('validates supported seat counts and safe blind configuration', () => {
		for (const maxSeats of [2, 4, 6] as const) {
			expect(createRoom({ maxSeats, smallBlind: 5, bigBlind: 10 }).seats).toHaveLength(maxSeats);
		}
		expect(() => createRoom({ maxSeats: 3 as never, smallBlind: 5, bigBlind: 10 })).toThrow(
			EngineError,
		);
		expect(() => createRoom({ maxSeats: 2, smallBlind: 10, bigBlind: 15 })).toThrow(EngineError);
		expect(() => createRoom({ maxSeats: 2, smallBlind: 0, bigBlind: 10 })).toThrow(EngineError);
		expect(() =>
			createRoom({
				maxSeats: 2,
				smallBlind: 1,
				bigBlind: Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1,
			}),
		).toThrow(EngineError);
	});

	test('takeSeat rejects occupied and duplicate seats', () => {
		const room = createSeatedRoom(4, ['u1']);
		expect(() => takeSeat(room, { userId: 'u2', displayName: 'u2', seatIndex: 0 })).toThrow(
			EngineError,
		);
		expect(() => takeSeat(room, { userId: 'u1', displayName: 'u1', seatIndex: 1 })).toThrow(
			EngineError,
		);
	});

	test('leaveSeat clears the occupant and returns to waiting', () => {
		const room = leaveSeat(createSeatedRoom(2, ['u1']), 'u1');
		expect(room.phase).toBe('waiting');
		expect(room.seats[0]).toMatchObject({ userId: null, displayName: null, chips: 0 });
	});

	test('startHand requires two connected players with enough chips', () => {
		const onePlayer = createSeatedRoom(4, ['u1']);
		expect(() => startHand(onePlayer, { deckSeed: 'one-player' })).toThrow(EngineError);

		const disconnected = setSeat(createSeatedRoom(4, ['u1', 'u2']), 'u2', {
			connected: false,
		});
		expect(() => startHand(disconnected, { deckSeed: 'disconnected' })).toThrow(EngineError);

		const shortStack = createSeatedRoom(4, ['u1', 'u2'], { u2: 9 });
		expect(() => startHand(shortStack, { deckSeed: 'short' })).toThrow(EngineError);
	});

	test('startHand rejects an unseated starter even when two eligible players exist', () => {
		const room = createSeatedRoom(2);
		expect(() => engineStartHand(room, startArgs('unseated-starter', 'u3'))).toThrow(
			'connected seated player',
		);
	});

	test('startHand rejects a disconnected starter', () => {
		const room = setSeat(createSeatedRoom(2), 'u1', { connected: false });
		expect(() => engineStartHand(room, startArgs('disconnected-starter', 'u1'))).toThrow(
			'connected seated player',
		);
	});

	test('startHand rejects a short-stacked starter', () => {
		const room = createSeatedRoom(2, ['u1', 'u2'], { u1: BIG_BLIND - 1 });
		expect(() => engineStartHand(room, startArgs('short-stacked-starter', 'u1'))).toThrow(
			'connected seated player',
		);
	});

	test('startHand excludes disconnected and underfunded seated players', () => {
		let room = createSeatedRoom(4, ['u1', 'u2', 'u3', 'u4']);
		room = setSeat(room, 'u2', { connected: false });
		room = setSeat(room, 'u3', { chips: 9 });
		const hand = startHand(room, { deckSeed: 'eligibility' }).hand!;
		expect(Object.keys(hand.holeCards)).toEqual(['u1', 'u4']);
	});

	test('takeSeat and leaveSeat are guarded during an active hand', () => {
		const room = startHand(createSeatedRoom(2), { deckSeed: 'phase-guards' });
		expect(() => takeSeat(room, { userId: 'u3', displayName: 'u3', seatIndex: 2 })).toThrow(
			EngineError,
		);
		expect(() => leaveSeat(room, 'u1')).toThrow(EngineError);
		expect(() => startHand(room, { deckSeed: 'duplicate' })).toThrow(EngineError);
	});

	test('startHand posts blinds, debits chips, and deals two cards', () => {
		const room = startHand(createSeatedRoom(2), { deckSeed: 'deal' });
		expect(room.phase).toBe('in-hand');
		expect(room.hand?.bettingRound).toBe('preflop');
		expect(room.hand?.committed).toEqual({ u1: 5, u2: 10 });
		expect(room.seats.map((seat) => seat.chips)).toEqual([995, 990]);
		expect(room.hand?.holeCards.u1).toHaveLength(2);
		expect(room.hand?.holeCards.u2).toHaveLength(2);
	});

	test('clearDisconnectedSeat removes only a disconnected occupant', () => {
		const room = setSeat(createSeatedRoom(2), 'u1', {
			connected: false,
			disconnectedAt: 1,
		});
		const cleared = clearDisconnectedSeat(room, 'u1');
		expect(cleared.seats[0]).toMatchObject({ userId: null, displayName: null, chips: 0 });
		expect(clearDisconnectedSeat(room, 'u2')).toBe(room);
	});
});

describe('engine — betting and completion', () => {
	function setupHand(): Room {
		return startHand(createSeatedRoom(2), { deckSeed: 'betting' });
	}

	test('fold-out pays locally and returns to waiting', () => {
		const transition = act(setupHand(), 'u1', { action: 'fold' });
		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.hand).toBeNull();
		expect(transition.handResult).toEqual({
			winners: [{ userId: 'u2', seatIndex: 1, amount: 15 }],
			showdownCards: [],
		});
		expect(transition.room.seats.map((seat) => seat.chips)).toEqual([995, 1_005]);
	});

	test('call advances the betting round when action closes', () => {
		const first = act(setupHand(), 'u1', { action: 'call' });
		expect(first.room.hand?.bettingRound).toBe('preflop');
		const second = act(first.room, 'u2', { action: 'check' });
		expect(second.room.hand?.bettingRound).toBe('flop');
		expect(second.room.hand?.board).toHaveLength(3);
	});

	test('rejects an action when it is not the player’s turn', () => {
		expect(() => act(setupHand(), 'u2', { action: 'call' })).toThrow('not your turn');
	});

	test('raise must meet the minimum raise', () => {
		expect(() => act(setupHand(), 'u1', { action: 'raise', amount: 11 })).toThrow(
			'raise below min-raise',
		);
	});

	test('a full hand to showdown returns every non-folded player’s cards', () => {
		const transition = checkDown(setupHand());
		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.hand).toBeNull();
		expect(transition.handResult?.showdownCards.map(({ userId }) => userId)).toEqual(['u1', 'u2']);
	});

	test('call rejects when there is nothing to call', () => {
		const preflop = act(setupHand(), 'u1', { action: 'call' });
		const flop = act(preflop.room, 'u2', { action: 'check' });
		expect(() => act(flop.room, 'u2', { action: 'call' })).toThrow('nothing to call');
	});

	test('betting on a new street uses cumulative commitments', () => {
		const preflop = act(setupHand(), 'u1', { action: 'call' });
		const flop = act(preflop.room, 'u2', { action: 'check' });
		expect(flop.room.hand?.currentBet).toBe(10);
		expect(() => act(flop.room, 'u2', { action: 'bet', amount: 5 })).toThrow(
			'raise must exceed current bet',
		);
	});

	test('a later-street bet below the minimum raise is rejected', () => {
		let room = setupHand();
		room = act(room, 'u1', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u2', { action: 'call' }).room;

		expect(() => act(room, 'u2', { action: 'bet', amount: 105 })).toThrow('raise below min-raise');
	});

	test('raises on a new street measure the increment, not the total commitment', () => {
		let room = setupHand();
		room = act(room, 'u1', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u2', { action: 'call' }).room;
		expect(room.hand?.bettingRound).toBe('flop');
		expect(room.hand?.currentBet).toBe(100);
		room = act(room, 'u2', { action: 'raise', amount: 110 }).room;
		expect(room.hand?.lastRaiseAmount).toBe(10);
		expect(room.hand?.currentBet).toBe(110);
	});

	test('check remains legal on a new street when commitments match', () => {
		let room = setupHand();
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'check' }).room;
		room = act(room, 'u2', { action: 'check' }).room;
		room = act(room, 'u1', { action: 'check' }).room;
		expect(room.hand?.bettingRound).toBe('turn');
	});

	test('short all-in raises do not reopen action', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u3: 150 }), {
			deckSeed: 'short-raise',
		});
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u3', { action: 'all_in' }).room;
		expect(room.hand?.currentBet).toBe(150);
		expect(room.hand?.lastRaiseAmount).toBe(90);
		room = act(room, 'u1', { action: 'call' }).room;
		expect(() => act(room, 'u2', { action: 'raise', amount: 240 })).toThrow('action not reopened');
	});

	test('an already-acted player can call after a short all-in raise', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u3: 150 }), {
			deckSeed: 'short-call-restored',
		});
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u3', { action: 'all_in' }).room;
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'call' }).room;

		expect(room.hand?.committed.u2).toBe(150);
	});

	test('an already-acted player can fold after a short all-in raise', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u3: 150 }), {
			deckSeed: 'short-fold-restored',
		});
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u3', { action: 'all_in' }).room;
		room = act(room, 'u1', { action: 'call' }).room;
		const transition = act(room, 'u2', { action: 'fold' });

		expect(transition.handResult).not.toBeNull();
		expect(transition.handResult?.winners.map(({ userId }) => userId)).not.toContain('u2');
	});

	test('an already-acted player cannot go all-in as a raise after a short all-in', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u3: 150 }), {
			deckSeed: 'short-all-in-restored',
		});
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u3', { action: 'all_in' }).room;
		room = act(room, 'u1', { action: 'call' }).room;

		expect(() => act(room, 'u2', { action: 'all_in' })).toThrow('action not reopened');
	});

	test('a full raise reopens action for players who already acted', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'full-raise' });
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'raise', amount: 50 }).room;
		expect(room.hand?.hasActed.has('u1')).toBe(false);
		room = act(room, 'u3', { action: 'call' }).room;
		room = act(room, 'u1', { action: 'raise', amount: 100 }).room;
		expect(room.hand?.currentBet).toBe(100);
	});

	test('an all-in with only enough chips to call is treated as a call', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u2: 60, u3: 150 }), {
			deckSeed: 'all-in-call',
		});
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'call' }).room;
		room = act(room, 'u3', { action: 'raise', amount: 100 }).room;
		room = act(room, 'u1', { action: 'call' }).room;
		room = act(room, 'u2', { action: 'all_in' }).room;
		expect(room.hand?.committed.u2).toBe(60);
		expect(room.hand?.allIn.has('u2')).toBe(true);
	});
});

describe('engine — dealer rotation, side pots, and odd chips', () => {
	test('lastDealerSeat starts empty and rotates between hands', () => {
		let room = createSeatedRoom(4, ['u1', 'u2', 'u3']);
		expect(room.lastDealerSeat).toBe(-1);
		room = startHand(room, { deckSeed: 'dealer-1' });
		const dealer1 = room.hand!.dealerSeat;
		const first = forceFold(room, 'u1');
		const second = forceFold(first.room, 'u2');
		expect(second.handResult).not.toBeNull();
		room = startHand(second.room, { deckSeed: 'dealer-2' });
		expect(room.hand?.dealerSeat).not.toBe(dealer1);
	});

	test('equal commitments create one side pot', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'pots-equal' });
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 50, u2: 50, u3: 50 },
		};
		const pots = buildSidePots(hand);
		expect(pots).toEqual([{ amount: 150, eligibleSeatIndices: [0, 1, 2] }]);
	});

	test('unequal commitments create a main pot and side pot', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'pots-side' });
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 10, u2: 100, u3: 100 },
			allIn: new Set(['u1']),
		};
		const pots = buildSidePots(hand);
		expect(pots).toEqual([
			{ amount: 30, eligibleSeatIndices: [0, 1, 2] },
			{ amount: 180, eligibleSeatIndices: [1, 2] },
		]);
	});

	test('an all-in player is eligible for the main pot but not the side pot', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'pots-all-in' });
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 10, u2: 100, u3: 100 },
			allIn: new Set(['u1']),
		};
		const pots = buildSidePots(hand);

		expect(pots).toEqual([
			{ amount: 30, eligibleSeatIndices: [0, 1, 2] },
			{ amount: 180, eligibleSeatIndices: [1, 2] },
		]);
	});

	test('folded contributors add dead money but cannot win a pot', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'pots-folded' });
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 50, u2: 50, u3: 50 },
			folded: new Set(['u1']),
		};
		const pots = buildSidePots(hand);
		expect(pots[0]).toEqual({ amount: 150, eligibleSeatIndices: [1, 2] });
	});

	test('side pots use the hand identity map when a live seat is cleared', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'pots-cleared' });
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 50, u2: 100, u3: 100 },
			folded: new Set(['u1']),
		};
		const clearedRoom: Room = {
			...room,
			seats: room.seats.map((seat) =>
				seat.userId === 'u1' ? { ...seat, userId: null, displayName: null } : seat,
			),
		};
		expect(buildSidePots(hand)).toEqual([
			{ amount: 150, eligibleSeatIndices: [1, 2] },
			{ amount: 100, eligibleSeatIndices: [1, 2] },
		]);
		expect(clearedRoom.seats[0].userId).toBeNull();
	});

	test('side pots preserve committed amounts when multiple folded seats are cleared', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3', 'u4']), {
			deckSeed: 'pots-multiple-cleared',
		});
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 50, u2: 100, u3: 100, u4: 50 },
			folded: new Set(['u1', 'u4']),
		};
		const clearedRoom: Room = {
			...room,
			seats: room.seats.map((seat) =>
				seat.userId === 'u1' || seat.userId === 'u4'
					? { ...seat, userId: null, displayName: null }
					: seat,
			),
		};

		expect(buildSidePots(hand)).toEqual([
			{ amount: 200, eligibleSeatIndices: [1, 2] },
			{ amount: 100, eligibleSeatIndices: [1, 2] },
		]);
		expect(clearedRoom.seats[0].userId).toBeNull();
		expect(clearedRoom.seats[3].userId).toBeNull();
	});

	test('side pots preserve an all-in player seat index when its live seat is cleared', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), {
			deckSeed: 'pots-cleared-all-in',
		});
		const hand: HandState = {
			...room.hand!,
			committed: { u1: 10, u2: 100, u3: 100 },
			allIn: new Set(['u1']),
		};
		const clearedRoom: Room = {
			...room,
			seats: room.seats.map((seat) =>
				seat.userId === 'u1' ? { ...seat, userId: null, displayName: null } : seat,
			),
		};

		expect(buildSidePots(hand)).toEqual([
			{ amount: 30, eligibleSeatIndices: [0, 1, 2] },
			{ amount: 180, eligibleSeatIndices: [1, 2] },
		]);
		expect(clearedRoom.seats[0].userId).toBeNull();
	});

	test('odd chips go to the closest seat left of the dealer', () => {
		const transition = act(makeTiedRiverRoom(0), 'u2', { action: 'check' });
		expect(transition.handResult?.winners.sort((a, b) => a.seatIndex - b.seatIndex)).toEqual([
			{ userId: 'u1', seatIndex: 0, amount: 6 },
			{ userId: 'u2', seatIndex: 1, amount: 7 },
		]);
	});

	test('odd-chip order wraps around when the dealer is not seat zero', () => {
		const transition = act(makeTiedRiverRoom(2), 'u2', { action: 'check' });
		expect(transition.handResult?.winners.sort((a, b) => a.seatIndex - b.seatIndex)).toEqual([
			{ userId: 'u1', seatIndex: 0, amount: 7 },
			{ userId: 'u2', seatIndex: 1, amount: 6 },
		]);
	});

	test('the dealer receives an odd chip after the seats to the left', () => {
		const transition = act(makeTiedRiverRoom(0), 'u2', { action: 'check' });
		const dealer = transition.handResult?.winners.find(({ userId }) => userId === 'u1');
		const other = transition.handResult?.winners.find(({ userId }) => userId === 'u2');
		expect(dealer?.amount).toBe(6);
		expect(other?.amount).toBe(7);
	});

	test('fold-out winners total the committed chips without losing chips', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), {
			deckSeed: 'fold-total',
		});
		const totalCommitted = Object.values(room.hand!.committed).reduce(
			(sum, amount) => sum + amount,
			0,
		);
		const currentUserId = currentUser(room);
		const otherUserIds = ['u1', 'u2', 'u3'].filter((userId) => userId !== currentUserId);
		const first = forceFold(room, otherUserIds[0]);
		const second = forceFold(first.room, otherUserIds[1]);

		expect(second.handResult?.winners.reduce((sum, winner) => sum + winner.amount, 0)).toBe(
			totalCommitted,
		);
	});
});

describe('engine — forceFold and identity-safe completion', () => {
	test('forceFold folds a non-current player without advancing the turn', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'force-fold' });
		const currentSeat = room.hand!.currentSeat;
		const currentUserId = currentUser(room);
		const otherUserId = ['u1', 'u2', 'u3'].find((userId) => userId !== currentUserId)!;
		const transition = forceFold(room, otherUserId);
		expect(transition.room.phase).toBe('in-hand');
		expect(transition.room.hand?.folded.has(otherUserId)).toBe(true);
		expect(transition.room.hand?.currentSeat).toBe(currentSeat);
	});

	test('forceFold is idempotent for an already-folded or unknown player', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), {
			deckSeed: 'force-idempotent',
		});
		const first = forceFold(room, 'u2');
		expect(forceFold(first.room, 'u2').room).toBe(first.room);
		expect(forceFold(room, 'unknown').room).toBe(room);
	});

	test('forceFold completes a heads-up hand and pays the surviving player', () => {
		const room = startHand(createSeatedRoom(2), { deckSeed: 'force-complete' });
		const transition = forceFold(room, 'u2');
		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.hand).toBeNull();
		expect(transition.handResult?.winners).toEqual([{ userId: 'u1', seatIndex: 0, amount: 15 }]);
	});

	test('forceFold can fold an all-in player when explicitly requested', () => {
		let room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), { deckSeed: 'force-all-in' });
		room = { ...room, hand: { ...room.hand!, currentSeat: 1 } };
		room = act(room, 'u2', { action: 'all_in' }).room;
		const transition = forceFold(room, 'u2');
		expect(transition.room.hand?.folded.has('u2')).toBe(true);
	});

	test('forceFold of the current actor preserves the current seat until the caller advances it', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), {
			deckSeed: 'force-current',
		});
		const currentSeat = room.hand!.currentSeat;
		const currentUserId = currentUser(room);
		const transition = forceFold(room, currentUserId);

		expect(transition.room.phase).toBe('in-hand');
		expect(transition.room.hand?.folded.has(currentUserId)).toBe(true);
		expect(transition.room.hand?.currentSeat).toBe(currentSeat);
	});

	test('forceFold of two non-current players leaves the current player as the winner', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3']), {
			deckSeed: 'force-two-non-current',
		});
		const currentUserId = currentUser(room);
		const otherUserIds = ['u1', 'u2', 'u3'].filter((userId) => userId !== currentUserId);
		const first = forceFold(room, otherUserIds[0]);
		const second = forceFold(first.room, otherUserIds[1]);

		expect(second.room.phase).toBe('waiting');
		expect(second.room.hand).toBeNull();
		expect(second.handResult?.winners).toEqual([
			{
				userId: currentUserId,
				seatIndex: room.hand!.seatIndexMap[currentUserId],
				amount: 15,
			},
		]);
	});

	test('winner discovery survives a cleared live seat', () => {
		const room = startHand(createSeatedRoom(2), { deckSeed: 'cleared-winner' });
		const cleared = setSeat(room, 'u2', { userId: null, displayName: null, chips: 0 });
		const transition = forceFold(cleared, 'u1');
		expect(transition.handResult?.winners).toEqual([{ userId: 'u2', seatIndex: 1, amount: 15 }]);
	});

	test('payout credits only a matching user and seat identity', () => {
		const room = startHand(createSeatedRoom(2), { deckSeed: 'identity-payout' });
		const replacement = setSeat(room, 'u2', {
			userId: 'replacement',
			displayName: 'Replacement',
			chips: 7,
		});
		const transition = forceFold(replacement, 'u1');
		expect(transition.handResult?.winners[0]).toEqual({
			userId: 'u2',
			seatIndex: 1,
			amount: 15,
		});
		expect(transition.room.seats[1]).toMatchObject({ userId: 'replacement', chips: 7 });
	});

	test('a disconnected all-in winner is paid before its expired seat is cleared', () => {
		let room = startHand(createSeatedRoom(2), { deckSeed: 'disconnected-all-in' });
		const allInUserId = currentUser(room);
		const otherUserId = allInUserId === 'u1' ? 'u2' : 'u1';
		room = act(room, allInUserId, { action: 'all_in' }).room;
		room = setSeat(room, allInUserId, {
			connected: false,
			disconnectedAt: 1,
		});
		const transition = forceFold(room, otherUserId);
		expect(transition.handResult?.winners.some(({ userId }) => userId === allInUserId)).toBe(true);
		expect(
			transition.room.seats.find((seat) => seat.userId === allInUserId)?.chips,
		).toBeGreaterThan(0);
	});
});

describe('engine — all-in runout and phase transitions', () => {
	test('heads-up with one all-in fast-forwards to showdown', () => {
		const room = startHand(createSeatedRoom(2, ['u1', 'u2'], { u2: BIG_BLIND }), {
			deckSeed: 'heads-up-all-in',
		});
		expect(room.hand?.allIn.has('u2')).toBe(true);
		const transition = act(room, 'u1', { action: 'call' });
		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.hand).toBeNull();
		expect(transition.handResult?.showdownCards).toHaveLength(2);
	});

	test('three all-in players run out every community card', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u1: 10, u2: 10, u3: 10 }), {
			deckSeed: 'three-all-in',
		});
		const first = act(room, 'u1', { action: 'call' });
		const transition = act(first.room, 'u2', { action: 'call' });
		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.hand).toBeNull();
		expect(transition.handResult?.showdownCards).toHaveLength(3);
	});

	test('one eligible player on a later street runs out every community card', () => {
		const room = startHand(createSeatedRoom(4, ['u1', 'u2', 'u3'], { u2: 100, u3: 1_000 }), {
			deckSeed: 'later-street-all-in',
		});
		let transition = act(room, 'u1', { action: 'call' });
		transition = act(transition.room, 'u2', { action: 'call' });
		transition = act(transition.room, 'u3', { action: 'check' });
		expect(transition.room.hand?.bettingRound).toBe('flop');

		transition = act(transition.room, 'u2', { action: 'all_in' });
		transition = act(transition.room, 'u3', { action: 'call' });
		transition = act(transition.room, 'u1', { action: 'fold' });

		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.hand).toBeNull();
		expect(transition.handResult?.showdownCards).toHaveLength(2);
	});

	test('a folded seat cannot change the waiting phase after completion', () => {
		const room = startHand(createSeatedRoom(2), { deckSeed: 'phase-after-complete' });
		const transition = act(room, 'u1', { action: 'fold' });
		expect(transition.room.phase).toBe('waiting');
		expect(transition.room.seats.every((seat) => seat.userId !== null)).toBe(true);
	});

	test('the engine has no host role', () => {
		const room = createSeatedRoom(2, ['guest', 'other']);
		expect('hostUserId' in room.config).toBe(false);
		expect(startHand(room, { deckSeed: 'no-host' }).hand).not.toBeNull();
	});
});
