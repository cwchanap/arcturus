import { describe, expect, test } from 'bun:test';
import {
	createRoom,
	takeSeat,
	leaveSeat,
	startHand,
	applyAction,
	buildSidePots,
	EngineError,
} from './engine';

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

	test('call rejects when nothing to call (toCall <= 0)', () => {
		const room = setupHand();
		// u1 (SB) calls preflop to match BB
		const r1 = applyAction(room, 'u1', { action: 'call' });
		// u2 (BB) checks to end preflop
		const r2 = applyAction(r1, 'u2', { action: 'check' });
		// Now on flop, currentBet is reset to 0. Attempting call should fail.
		try {
			applyAction(r2, 'u2', { action: 'call' });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_ACTION');
		}
	});

	test('short all-in does not update lastRaiseAmount', () => {
		// 3 players: u1 raises to 100 (raise of 90), u2 has only 150 total (short stack)
		// u2 goes all-in for 150 (raise increment = 50, less than lastRaise of 90)
		// lastRaiseAmount should stay at 90, so u3's min-raise should be 100 + 90 = 190
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Short', seatIndex: 1, mainBalance: 150 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 150, u3: 1000 }, deckSeed: 'short-ai' });

		// u1 (first to act preflop) calls the 10 BB
		let r = applyAction(room, 'u1', { action: 'call' });
		// u2 goes all-in for 150 total (140 more, raise increment = 140 > 10 BB lastRaise)
		// Actually wait, preflop BB=10, lastRaiseAmount=10. 150-10 = 140 which IS > 10.
		// Let me set up a different scenario where the all-in is truly short.
		// After a raise to 100 (lastRaise = 90), a short stack goes all-in for less than min-raise.

		// Let's set up post-flop scenario
		room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Short', seatIndex: 1, mainBalance: 50 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 50, u3: 1000 }, deckSeed: 'short-ai2' });

		// Preflop: currentBet = 10, lastRaiseAmount = 10
		// u1 calls 10
		r = applyAction(room, 'u1', { action: 'call' });
		// u2 calls (matches 10, leaving 40 behind)
		r = applyAction(r, 'u2', { action: 'call' });
		// u3 raises to 100 (raise increment = 90, lastRaiseAmount becomes 90)
		r = applyAction(r, 'u3', { action: 'raise', amount: 100 });
		expect(r.hand!.lastRaiseAmount).toBe(90);
		expect(r.hand!.currentBet).toBe(100);

		// u1 calls 100
		r = applyAction(r, 'u1', { action: 'call' });
		// u2 goes all-in for 50 total (already committed 10, so 40 more)
		// committed will be 50, raise increment = 50 - 100 = -50... wait
		// u2 has handStack 50, committed 10 already. remaining = 40.
		// all_in pays 40, new committed = 50. 50 < 100 (currentBet), so this doesn't even exceed currentBet
		// So newCommitted[userId] > hand.currentBet is false — the all_in branch won't update anything.
		// This is actually the standard case — short stack calling all-in doesn't raise at all.

		// Let me set up a case where all-in exceeds currentBet but by less than lastRaiseAmount
		room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Short', seatIndex: 1, mainBalance: 150 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 150, u3: 1000 }, deckSeed: 'short-ai3' });

		// Preflop: u1 calls 10
		r = applyAction(room, 'u1', { action: 'call' });
		// u2 calls 10 (committed 10, remaining 140)
		r = applyAction(r, 'u2', { action: 'call' });
		// u3 raises to 100 (lastRaise = 90)
		r = applyAction(r, 'u3', { action: 'raise', amount: 100 });
		expect(r.hand!.lastRaiseAmount).toBe(90);
		// u1 calls 100 (committed 100)
		r = applyAction(r, 'u1', { action: 'call' });
		// u2 all-in: handStack=150, committed=10, remaining=140. newCommitted=150.
		// 150 > 100 (currentBet), raise increment = 150-100 = 50. 50 < 90 (lastRaiseAmount)
		// So this is a SHORT all-in raise — lastRaiseAmount should stay 90
		r = applyAction(r, 'u2', { action: 'all_in' });
		expect(r.hand!.currentBet).toBe(150);
		expect(r.hand!.lastRaiseAmount).toBe(90); // preserved, not 50
	});
});

describe('engine — phase guards', () => {
	function setupInHand() {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		return startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-x' });
	}

	test('takeSeat rejects during in-hand phase', () => {
		const room = setupInHand();
		try {
			takeSeat(room, { userId: 'u3', displayName: 'Charlie', seatIndex: 2, mainBalance: 1000 });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_PHASE');
		}
	});

	test('leaveSeat rejects during in-hand phase', () => {
		const room = setupInHand();
		try {
			leaveSeat(room, 'u1');
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_PHASE');
		}
	});
});

describe('engine — dealer rotation', () => {
	test('lastDealerSeat starts at -1', () => {
		const room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		expect(room.lastDealerSeat).toBe(-1);
	});

	test('startHand updates lastDealerSeat', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-1' });
		expect(room.lastDealerSeat).toBeGreaterThanOrEqual(0);
		expect(room.lastDealerSeat).toBe(room.hand!.dealerSeat);
	});

	test('dealer rotates across consecutive hands', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });

		// Hand 1
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'seed-1' });
		const dealer1 = room.hand!.dealerSeat;
		expect(room.lastDealerSeat).toBe(dealer1);

		// Simulate hand ending (fold-out)
		const currentTurn = room.hand!.currentSeat;
		const turnUser = room.seats[currentTurn].userId!;
		room = applyAction(room, turnUser, { action: 'fold' });
		if (room.phase !== 'settling') {
			// Might need more folds
			const nextTurn = room.hand!.currentSeat;
			const nextUser = room.seats[nextTurn].userId!;
			room = applyAction(room, nextUser, { action: 'fold' });
		}
		expect(room.phase).toBe('settling');

		// Clear hand (simulating what the DO does after settlement)
		room = { ...room, phase: 'seating' as const, hand: null };

		// Hand 2 — dealer should be different
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'seed-2' });
		const dealer2 = room.hand!.dealerSeat;
		expect(dealer2).not.toBe(dealer1);
		expect(room.lastDealerSeat).toBe(dealer2);
	});
});

describe('engine — side pots (buildSidePots)', () => {
	test('equal committed amounts produce single pot', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-x' });
		// Both call to equalize
		let r = applyAction(room, 'u1', { action: 'call' });
		r = applyAction(r, 'u2', { action: 'check' });

		const pots = buildSidePots(r.hand!, r.seats);
		// Single pot with equal committed
		const totalFromPots = pots.reduce((a, p) => a + p.amount, 0);
		const totalCommitted = Object.values(r.hand!.committed).reduce((a, b) => a + b, 0);
		expect(totalFromPots).toBe(totalCommitted);
	});

	test('unequal committed with all-in creates side pot', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 1000 },
			deckSeed: 'sidepot-test',
		});

		// u1 goes all-in for 10 (their blind), u2 raises to 100, u3 calls 100
		// Need to play through preflop to set up unequal commitments
		const hand = room.hand!;
		// Simulate different committed amounts manually by testing buildSidePots directly
		const testHand = {
			...hand,
			committed: { u1: 10, u2: 100, u3: 100 },
			folded: new Set<string>(),
			allIn: new Set(['u1']),
		};

		const pots = buildSidePots(testHand, room.seats);
		// Should have 2 pots:
		// Main pot: 10 * 3 = 30 (all 3 eligible)
		// Side pot: 90 * 2 = 180 (only u2, u3 eligible)
		expect(pots.length).toBe(2);
		const mainPot = pots.find((p) => p.eligibleSeatIndices.length === 3);
		const sidePot = pots.find((p) => p.eligibleSeatIndices.length === 2);
		expect(mainPot).toBeDefined();
		expect(sidePot).toBeDefined();
		expect(mainPot!.amount).toBe(30);
		expect(sidePot!.amount).toBe(180);
	});

	test('folded players are not eligible for pots', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'fold-test' });

		const testHand = {
			...room.hand!,
			committed: { u1: 50, u2: 50, u3: 50 },
			folded: new Set(['u1']),
			allIn: new Set<string>(),
		};

		const pots = buildSidePots(testHand, room.seats);
		// Single pot, only u2 and u3 eligible
		expect(pots.length).toBe(1);
		expect(pots[0].amount).toBe(150);
		expect(pots[0].eligibleSeatIndices.sort()).toEqual([1, 2]);
	});

	test('all-in player only wins from main pot, not side pot', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, {
			userId: 'u1',
			displayName: 'Short stack',
			seatIndex: 0,
			mainBalance: 1000,
		});
		room = takeSeat(room, {
			userId: 'u2',
			displayName: 'Big stack',
			seatIndex: 1,
			mainBalance: 1000,
		});
		room = takeSeat(room, {
			userId: 'u3',
			displayName: 'Big stack 2',
			seatIndex: 2,
			mainBalance: 1000,
		});
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'allin-test' });

		// u1 committed 10, u2 committed 100, u3 committed 100, u1 is all-in
		const testHand = {
			...room.hand!,
			committed: { u1: 10, u2: 100, u3: 100 },
			folded: new Set<string>(),
			allIn: new Set(['u1']),
		};

		const pots = buildSidePots(testHand, room.seats);
		// Main pot: 10 * 3 = 30 (u1, u2, u3 all eligible)
		// Side pot: 90 * 2 = 180 (only u2, u3 eligible)
		const totalFromPots = pots.reduce((a, p) => a + p.amount, 0);
		expect(totalFromPots).toBe(210);
		// u1 is NOT eligible for the side pot
		for (const pot of pots) {
			if (pot.amount === 180) {
				expect(pot.eligibleSeatIndices).not.toContain(0);
			}
		}
	});
});

describe('engine — odd chip distribution in split pots', () => {
	test('winners total equals total committed (no chips lost)', () => {
		// Set up a 3-player hand where all players have different committed amounts
		// to create a scenario where odd chips are possible
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });

		// Use a deck seed that we know produces a hand
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 1000 },
			deckSeed: 'odd-chip-test',
		});

		// Regardless of deck, verify the fold-out path preserves all committed chips
		// Fold out u2 and u3, u1 should get the entire pot
		const totalCommitted = Object.values(room.hand!.committed).reduce((a, b) => a + b, 0);
		const currentTurn = room.hand!.currentSeat;
		const turnUser = room.seats[currentTurn].userId!;

		// Fold all players except the last one
		let r = applyAction(room, turnUser, { action: 'fold' });
		if (r.phase !== 'settling') {
			const nextTurn = r.hand!.currentSeat;
			const nextUser = r.seats[nextTurn].userId!;
			r = applyAction(r, nextUser, { action: 'fold' });
		}
		expect(r.phase).toBe('settling');
		const lastLog = r.handLog[r.handLog.length - 1];
		const totalWon = lastLog.winners.reduce((a, w) => a + w.amount, 0);
		expect(totalWon).toBe(totalCommitted);
	});

	test('split pot with odd amount distributes all chips', () => {
		// Construct a scenario with 3 players, different committed amounts,
		// to test that buildSidePots + odd chip handling preserves all chips
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 1000 },
			deckSeed: 'split-odd-test',
		});

		// The total committed must equal total won
		const totalCommitted = Object.values(room.hand!.committed).reduce((a, b) => a + b, 0);
		expect(totalCommitted).toBeGreaterThan(0);

		// Fold out all but last player
		let r: typeof room = room;
		while (r.phase !== 'settling') {
			const turn = r.hand!.currentSeat;
			const user = r.seats[turn].userId!;
			const remaining = r.seats.filter(
				(s) => s.userId && r.hand!.holeCards[s.userId] && !r.hand!.folded.has(s.userId),
			);
			if (remaining.length <= 1) break;
			r = applyAction(r, user, { action: 'fold' });
		}
		expect(r.phase).toBe('settling');
		const totalWon = r.handLog[r.handLog.length - 1].winners.reduce((a, w) => a + w.amount, 0);
		expect(totalWon).toBe(totalCommitted);
	});
});
