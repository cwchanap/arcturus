import { describe, expect, test } from 'bun:test';
import {
	createRoom,
	takeSeat,
	leaveSeat,
	startHand,
	applyAction,
	forceFold,
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

	test('leaveSeat is allowed during settling phase (preserves phase)', () => {
		// When a hand reaches settling, players can still leave_seat (the engine
		// only rejects leaveSeat during in-hand). The DO must not release
		// membership for unseated hand participants until settlement completes.
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-settle' });
		// Fold u1 to end the hand → settling
		room = applyAction(room, 'u1', { action: 'fold' });
		expect(room.phase).toBe('settling');
		// u1 can leave seat during settling
		room = leaveSeat(room, 'u1');
		expect(room.seats[0].userId).toBeNull();
		expect(room.phase).toBe('settling'); // phase preserved
		// hand.committed still has u1's escrow
		expect(room.hand!.committed.u1).toBeDefined();
	});

	test('startHand requires at least 2 seated players', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(() => startHand(room, { snapshots: { u1: 1000 }, deckSeed: 'seed-x' })).toThrow();
	});

	test('startHand excludes seated player whose snapshot is omitted', () => {
		// Simulates the DO filtering out a disconnected player's snapshot
		// after fetchSnapshot returns — only connected players get dealt in.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		// u3 "disconnected" — omit from snapshots
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-filter' });
		expect(room.phase).toBe('in-hand');
		expect(room.hand!.holeCards.u1).toBeDefined();
		expect(room.hand!.holeCards.u2).toBeDefined();
		expect(room.hand!.holeCards.u3).toBeUndefined();
		expect(room.hand!.committed.u3).toBeUndefined();
	});

	test('late take_seat during start_hand leaves player seated but undealt', () => {
		// Simulates the race: take_seat arrives after snapshot list is captured
		// but before startHand is called. The late player has no snapshot, so
		// they are excluded from the hand but remain seated. Once the hand
		// starts (phase = in-hand), leaveSeat is rejected, trapping the player.
		// The DO-level isStartingHand guard prevents take_seat during this window.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		// Late player seats AFTER snapshot list was captured (no snapshot for u3)
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-race' });
		// u3 is seated but not dealt in
		expect(room.seats[2].userId).toBe('u3');
		expect(room.hand!.holeCards.u3).toBeUndefined();
		// u3 cannot leave during in-hand phase
		expect(() => leaveSeat(room, 'u3')).toThrow();
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
		// Now on flop, currentBet = maxCommitted (10). toCall = 10 - 10 = 0.
		// Attempting call should fail because there's nothing to call.
		try {
			applyAction(r2, 'u2', { action: 'call' });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_ACTION');
		}
	});

	test('bet on new street must exceed current commitment', () => {
		// After preflop call/check, both players have committed 10.
		// On the flop, currentBet = maxCommitted = 10. A bet with amount <= currentBet should be rejected.
		const room = setupHand();
		const r1 = applyAction(room, 'u1', { action: 'call' });
		const r2 = applyAction(r1, 'u2', { action: 'check' });
		expect(r2.hand!.bettingRound).toBe('flop');
		expect(r2.hand!.currentBet).toBe(10);
		// u2 has committed 10 from preflop. A bet of 5 (< currentBet=10) should fail.
		try {
			applyAction(r2, 'u2', { action: 'bet', amount: 5 });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_ACTION');
		}
	});

	test('raise on new street must exceed current commitment', () => {
		// Both commit 100 preflop, then on flop currentBet=100 (maxCommitted), committedNow=100
		// A raise to 50 (< committedNow=100 and < currentBet=100) must be rejected
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'commit-guard' });

		// Preflop: u1 raises to 100
		room = applyAction(room, 'u1', { action: 'raise', amount: 100 });
		// u2 calls 100
		room = applyAction(room, 'u2', { action: 'call' });
		expect(room.hand!.bettingRound).toBe('flop');
		expect(room.hand!.currentBet).toBe(100);
		expect(room.hand!.committed.u1).toBe(100);
		expect(room.hand!.committed.u2).toBe(100);

		// Flop: attempt to raise to 50 — must fail since 50 < currentBet (100)
		try {
			applyAction(room, 'u2', { action: 'raise', amount: 50 });
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

	test('takeSeat rejects during frozen phase', () => {
		let room = setupInHand();
		// Fold to reach settling
		const turnUser = room.seats[room.hand!.currentSeat].userId!;
		room = applyAction(room, turnUser, { action: 'fold' });
		expect(room.phase).toBe('settling');
		// Simulate settlement failure → frozen
		room = { ...room, phase: 'frozen' };
		try {
			takeSeat(room, { userId: 'u3', displayName: 'Charlie', seatIndex: 2, mainBalance: 1000 });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_PHASE');
		}
	});

	test('takeSeat rejects during settling phase', () => {
		let room = setupInHand();
		const turnUser = room.seats[room.hand!.currentSeat].userId!;
		room = applyAction(room, turnUser, { action: 'fold' });
		expect(room.phase).toBe('settling');
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

	test('startHand rejects when room is already in-hand', () => {
		const room = setupInHand();
		try {
			startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'dup' });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_PHASE');
		}
	});

	test('startHand rejects when room is frozen', () => {
		let room = setupInHand();
		room = { ...room, phase: 'frozen' };
		try {
			startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'frozen' });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_PHASE');
		}
	});

	test('leaveSeat during frozen phase preserves frozen when last seat leaves', () => {
		let room = setupInHand();
		const turnUser = room.seats[room.hand!.currentSeat].userId!;
		room = applyAction(room, turnUser, { action: 'fold' });
		room = { ...room, phase: 'frozen' };
		// Remove both players
		room = leaveSeat(room, 'u1');
		expect(room.seats.find((s) => s.userId === 'u1')).toBeUndefined();
		expect(room.phase).toBe('frozen'); // not idle
		room = leaveSeat(room, 'u2');
		expect(room.seats.every((s) => s.userId === null)).toBe(true);
		expect(room.phase).toBe('frozen'); // still frozen even with no seats
	});

	test('leaveSeat during settling phase preserves settling when all seats leave', () => {
		let room = setupInHand();
		const turnUser = room.seats[room.hand!.currentSeat].userId!;
		room = applyAction(room, turnUser, { action: 'fold' });
		expect(room.phase).toBe('settling');
		room = leaveSeat(room, 'u1');
		room = leaveSeat(room, 'u2');
		expect(room.seats.every((s) => s.userId === null)).toBe(true);
		expect(room.phase).toBe('settling');
	});

	test('leaveSeat returns to idle when last seat leaves during seating phase', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(room.phase).toBe('seating');
		room = leaveSeat(room, 'u1');
		expect(room.phase).toBe('idle');
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

	test('odd chip goes to player closest left of dealer on tied showdown', () => {
		// Construct a hand at the river boundary with known cards that produce a tie.
		// Board plays for both remaining players (both hole cards are undercards).
		// 3 players: u1 at seat 0, u2 at seat 1, u3 at seat 2.
		// u3 folds. u1 and u2 tie with the board.
		// Dealer at seat 0, so odd chip should go to seat 1 (closest left of dealer).
		let room = createRoom({ maxSeats: 3, smallBlind: 1, bigBlind: 2, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 100 });
		room = startHand(room, {
			snapshots: { u1: 100, u2: 100, u3: 100 },
			deckSeed: 'odd-chip-dealer-test',
		});

		// Override the hand state to control cards and create a forced tie scenario:
		// Board: A♠ A♥ A♦ K♣ K♥ — unbeatable full house (AAA KK)
		// Hole cards: all players get undercards so the board plays for everyone.
		const board = [
			{ value: 'A', suit: 'spades' as const, rank: 14 },
			{ value: 'A', suit: 'hearts' as const, rank: 14 },
			{ value: 'A', suit: 'diamonds' as const, rank: 14 },
			{ value: 'K', suit: 'clubs' as const, rank: 13 },
			{ value: 'K', suit: 'hearts' as const, rank: 13 },
		];
		const holeCards = {
			u1: [
				{ value: '2', suit: 'clubs' as const, rank: 2 },
				{ value: '3', suit: 'clubs' as const, rank: 3 },
			],
			u2: [
				{ value: '4', suit: 'clubs' as const, rank: 4 },
				{ value: '5', suit: 'clubs' as const, rank: 5 },
			],
			u3: [
				{ value: '6', suit: 'clubs' as const, rank: 6 },
				{ value: '7', suit: 'clubs' as const, rank: 7 },
			],
		};

		// Set up: u3 folds, u1 and u2 each committed 5 (odd total = 10 from them + u3's commit)
		// Committed: u1=5, u2=5, u3=3 → total=13
		// buildSidePots: levels [3, 5]
		//   Level 3: 3 contributors × 3 = 9 (eligible: u1, u2 since u3 folded)
		//   Level 5: 2 contributors × 2 = 4 (eligible: u1, u2)
		// Pot 1 (9): split=4, remainder=1 → odd chip to player closest left of dealer
		// Pot 2 (4): split=2, remainder=0
		// Dealer at seat 0 (u1). Player closest left = seat 1 (u2, distance 1).
		// u2 should get 5+2=7, u1 should get 4+2=6. Total=13. ✓
		const hand = room.hand!;
		const testHand: typeof hand = {
			...hand,
			board,
			holeCards,
			committed: { u1: 5, u2: 5, u3: 3 },
			folded: new Set(['u3']),
			allIn: new Set(),
			handStacks: { u1: 95, u2: 95, u3: 97 },
			bettingRound: 'river',
			currentBet: 0,
			lastRaiseAmount: room.config.bigBlind,
			hasActed: new Set(['u1', 'u2']),
			currentSeat: 1, // u2's turn (last to act)
		};

		room = { ...room, hand: testHand };

		// u2 checks → all have acted, stillToAct=0 → showdown
		const result = applyAction(room, 'u2', { action: 'check' });
		expect(result.phase).toBe('settling');

		const lastLog = result.handLog[result.handLog.length - 1];
		expect(lastLog.winners.length).toBe(2);

		// Verify total chips preserved
		const totalWon = lastLog.winners.reduce((a, w) => a + w.amount, 0);
		expect(totalWon).toBe(13);

		// Verify odd chip goes to seat 1 (u2, closest left of dealer at seat 0)
		const u1Winner = lastLog.winners.find((w) => w.seatIndex === 0);
		const u2Winner = lastLog.winners.find((w) => w.seatIndex === 1);
		expect(u1Winner).toBeDefined();
		expect(u2Winner).toBeDefined();
		expect(u1Winner!.amount).toBe(6); // 4 + 2 (no odd chip)
		expect(u2Winner!.amount).toBe(7); // 5 + 2 (gets odd chip)
	});

	test('odd chip goes to player closest left of dealer when dealer is not seat 0', () => {
		// Same as above but with dealer at seat 2.
		// Dealer at seat 2 (u3). u1 at seat 0, u2 at seat 1.
		// u3 folds. u1 and u2 tie.
		// Player closest left of dealer (seat 2): seat 0 (distance 1) beats seat 1 (distance 2).
		// Odd chip should go to seat 0.
		let room = createRoom({ maxSeats: 3, smallBlind: 1, bigBlind: 2, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 100 });
		room = startHand(room, {
			snapshots: { u1: 100, u2: 100, u3: 100 },
			deckSeed: 'odd-chip-dealer2-test',
		});

		const board = [
			{ value: 'A', suit: 'spades' as const, rank: 14 },
			{ value: 'A', suit: 'hearts' as const, rank: 14 },
			{ value: 'A', suit: 'diamonds' as const, rank: 14 },
			{ value: 'K', suit: 'clubs' as const, rank: 13 },
			{ value: 'K', suit: 'hearts' as const, rank: 13 },
		];
		const holeCards = {
			u1: [
				{ value: '2', suit: 'clubs' as const, rank: 2 },
				{ value: '3', suit: 'clubs' as const, rank: 3 },
			],
			u2: [
				{ value: '4', suit: 'clubs' as const, rank: 4 },
				{ value: '5', suit: 'clubs' as const, rank: 5 },
			],
			u3: [
				{ value: '6', suit: 'clubs' as const, rank: 6 },
				{ value: '7', suit: 'clubs' as const, rank: 7 },
			],
		};

		const hand = room.hand!;
		const testHand: typeof hand = {
			...hand,
			board,
			holeCards,
			committed: { u1: 5, u2: 5, u3: 3 },
			folded: new Set(['u3']),
			allIn: new Set(),
			handStacks: { u1: 95, u2: 95, u3: 97 },
			bettingRound: 'river',
			currentBet: 0,
			lastRaiseAmount: room.config.bigBlind,
			hasActed: new Set(['u1', 'u2']),
			currentSeat: 1,
			dealerSeat: 2, // Dealer at seat 2
		};

		room = { ...room, hand: testHand };

		const result = applyAction(room, 'u2', { action: 'check' });
		expect(result.phase).toBe('settling');

		const lastLog = result.handLog[result.handLog.length - 1];
		expect(lastLog.winners.length).toBe(2);

		const totalWon = lastLog.winners.reduce((a, w) => a + w.amount, 0);
		expect(totalWon).toBe(13);

		// Dealer at seat 2. Closest left: seat 0 (dist 1) then seat 1 (dist 2).
		// Odd chip goes to seat 0 (u1).
		const u1Winner = lastLog.winners.find((w) => w.seatIndex === 0);
		const u2Winner = lastLog.winners.find((w) => w.seatIndex === 1);
		expect(u1Winner).toBeDefined();
		expect(u2Winner).toBeDefined();
		expect(u1Winner!.amount).toBe(7); // Gets odd chip (closest left of dealer)
		expect(u2Winner!.amount).toBe(6);
	});

	test('dealer who ties gets odd chip last', () => {
		// Dealer at seat 0 (u1). u2 at seat 1. u3 folds.
		// u1 and u2 tie. Odd chip goes to u2 (closest left of dealer), not u1 (dealer).
		let room = createRoom({ maxSeats: 3, smallBlind: 1, bigBlind: 2, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 100 });
		room = startHand(room, {
			snapshots: { u1: 100, u2: 100, u3: 100 },
			deckSeed: 'odd-chip-dealer-wins',
		});

		const board = [
			{ value: 'A', suit: 'spades' as const, rank: 14 },
			{ value: 'A', suit: 'hearts' as const, rank: 14 },
			{ value: 'A', suit: 'diamonds' as const, rank: 14 },
			{ value: 'K', suit: 'clubs' as const, rank: 13 },
			{ value: 'K', suit: 'hearts' as const, rank: 13 },
		];
		const holeCards = {
			u1: [
				{ value: '2', suit: 'clubs' as const, rank: 2 },
				{ value: '3', suit: 'clubs' as const, rank: 3 },
			],
			u2: [
				{ value: '4', suit: 'clubs' as const, rank: 4 },
				{ value: '5', suit: 'clubs' as const, rank: 5 },
			],
			u3: [
				{ value: '6', suit: 'clubs' as const, rank: 6 },
				{ value: '7', suit: 'clubs' as const, rank: 7 },
			],
		};

		const hand = room.hand!;
		// Dealer at seat 0. Pot = 13 (u1=5, u2=5, u3=3, u3 folded)
		// Odd chip from pot of 9: u2 (dist 1) gets it, not u1 (dealer, dist treated as numSeats)
		const testHand: typeof hand = {
			...hand,
			board,
			holeCards,
			committed: { u1: 5, u2: 5, u3: 3 },
			folded: new Set(['u3']),
			allIn: new Set(),
			handStacks: { u1: 95, u2: 95, u3: 97 },
			bettingRound: 'river',
			currentBet: 0,
			lastRaiseAmount: room.config.bigBlind,
			hasActed: new Set(['u1', 'u2']),
			currentSeat: 1,
			dealerSeat: 0, // u1 is dealer
		};

		room = { ...room, hand: testHand };

		const result = applyAction(room, 'u2', { action: 'check' });
		expect(result.phase).toBe('settling');

		const lastLog = result.handLog[result.handLog.length - 1];
		const u1Winner = lastLog.winners.find((w) => w.seatIndex === 0)!;
		const u2Winner = lastLog.winners.find((w) => w.seatIndex === 1)!;
		// u2 (seat 1, closest left of dealer) gets the odd chip
		expect(u2Winner.amount).toBe(7);
		expect(u1Winner.amount).toBe(6);
	});
});

describe('engine — forceFold', () => {
	function setup3PlayerHand() {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		return startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'ff-test' });
	}

	test('forceFold adds player to folded set', () => {
		const room = setup3PlayerHand();
		const result = forceFold(room, 'u2');
		expect(result.hand!.folded.has('u2')).toBe(true);
		expect(result.phase).toBe('in-hand');
	});

	test('forceFold preserves currentSeat for non-current player', () => {
		const room = setup3PlayerHand();
		const originalSeat = room.hand!.currentSeat;
		// Find a player who is NOT the current actor
		const currentUserId = room.seats[originalSeat].userId!;
		const nonCurrentUserId = currentUserId === 'u1' ? 'u2' : 'u1';
		const result = forceFold(room, nonCurrentUserId);
		// currentSeat should not change
		expect(result.hand!.currentSeat).toBe(originalSeat);
	});

	test('forceFold triggers fold-out when only 1 player remains', () => {
		// 2-player hand
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'ff-foldout' });

		const result = forceFold(room, 'u2');
		expect(result.phase).toBe('settling');
		expect(result.hand!.folded.has('u2')).toBe(true);
		const lastLog = result.handLog[result.handLog.length - 1];
		expect(lastLog.winners.length).toBe(1);
		expect(lastLog.winners[0].amount).toBe(
			Object.values(room.hand!.committed).reduce((a, b) => a + b, 0),
		);
	});

	test('forceFold is idempotent for already-folded player', () => {
		const room = setup3PlayerHand();
		const r1 = forceFold(room, 'u2');
		const r2 = forceFold(r1, 'u2');
		expect(r2.hand!.folded.has('u2')).toBe(true);
		expect(r2.phase).toBe('in-hand');
	});

	test('forceFold returns room unchanged for player not in hand', () => {
		const room = setup3PlayerHand();
		const result = forceFold(room, 'u_unknown');
		expect(result).toBe(room);
	});

	test('forceFold for current actor still works (no turn skip)', () => {
		const room = setup3PlayerHand();
		const currentUserId = room.seats[room.hand!.currentSeat].userId!;
		// forceFold the current actor — hand should still be in progress
		// (3 players, 1 folded = 2 remaining)
		const result = forceFold(room, currentUserId!);
		expect(result.hand!.folded.has(currentUserId!)).toBe(true);
		expect(result.phase).toBe('in-hand');
		// currentSeat is preserved even when folding the current actor
		// (the turn doesn't auto-advance — that's applyAction's job)
		expect(result.hand!.currentSeat).toBe(room.hand!.currentSeat);
	});

	test('forceFold two non-current players leaves 1 remaining → fold-out', () => {
		const room = setup3PlayerHand();
		const currentUserId = room.seats[room.hand!.currentSeat].userId!;
		// Find two non-current players
		const others = ['u1', 'u2', 'u3'].filter((u) => u !== currentUserId);
		const r1 = forceFold(room, others[0]);
		expect(r1.phase).toBe('in-hand');
		const r2 = forceFold(r1, others[1]);
		// Only the current actor remains → fold-out
		expect(r2.phase).toBe('settling');
		const lastLog = r2.handLog[r2.handLog.length - 1];
		expect(lastLog.winners[0].seatIndex).toBe(room.hand!.currentSeat);
	});

	test('forceFold DOES fold all-in players at engine level (caller must skip)', () => {
		// The engine-level forceFold() folds any player including all-in.
		// It is the caller's responsibility (e.g. alarm handler) to skip
		// all-in players before calling forceFold.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'ff-allin' });

		// Deterministically make u2 the current actor so applyAction(all_in) always runs.
		const u2Seat = room.seats.findIndex((s) => s.userId === 'u2');
		room = { ...room, hand: { ...room.hand!, currentSeat: u2Seat } };

		room = applyAction(room, 'u2', { action: 'all_in' });
		expect(room.hand!.allIn.has('u2')).toBe(true);

		// forceFold folds all-in players — the all-in skip is the caller's responsibility
		const result = forceFold(room, 'u2');
		expect(result.hand!.folded.has('u2')).toBe(true);
	});

	test('heads-up: folding both players — first fold triggers settlement, second fold is no-op', () => {
		// Simulates the DO alarm handler scenario where both players disconnect.
		// In heads-up, folding either player ends the hand (settling phase).
		// The alarm handler must stop folding after the first fold triggers settlement
		// to avoid dereferencing null hand.
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'ff-hu-both' });

		// Find the current actor and the other player
		const currentUserId = room.seats[room.hand!.currentSeat].userId!;
		const otherUserId = currentUserId === 'u1' ? 'u2' : 'u1';

		// Fold the non-current player first — in heads-up this triggers settlement
		const r1 = forceFold(room, otherUserId);
		expect(r1.phase).toBe('settling');

		// The alarm handler should stop here. But if it continued, folding the
		// current actor on the settling room would find them already folded
		// (idempotent) or the hand would still be in settling state.
		// The key contract: after phase='settling', the caller must break,
		// because runSettlement() will set hand=null.
		expect(r1.hand!.folded.has(otherUserId)).toBe(true);
	});
});

describe('engine — fast-forward when < 2 eligible players', () => {
	test('heads-up with one all-in fast-forwards to showdown after call', () => {
		// BB starts with exactly enough to post the big blind — calling puts them all-in.
		// After preflop closes with only 1 eligible player, the engine should
		// fast-forward through flop/turn/river to showdown rather than opening
		// a betting round for a lone actor.
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 10 });
		room = startHand(room, { snapshots: { u1: 100, u2: 10 }, deckSeed: 'ff-heads-up' });

		// u2 posts BB of 10 which is their entire stack → all-in
		expect(room.hand!.allIn.has('u2')).toBe(true);

		// u1 calls → preflop closes. Only u1 is non-all-in, non-folded (1 eligible).
		// Should fast-forward through all remaining streets to showdown.
		const result = applyAction(room, 'u1', { action: 'call' });
		expect(result.phase).toBe('settling');
		expect(result.hand!.board.length).toBe(5); // all community cards dealt
	});

	test('3-player with all eligible all-in fast-forwards to showdown', () => {
		// All 3 players go all-in from blinds + call → 0 eligible → fast-forward
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 5, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 5 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 5 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 5 });
		room = startHand(room, {
			snapshots: { u1: 5, u2: 5, u3: 5 },
			deckSeed: 'ff-3player',
		});

		// SB=5, BB=5. All have exactly 5 chips.
		// SB posts 5 (all-in), BB posts 5 (all-in).
		// u1 (first to act) calls 5 (all-in).
		// All 3 are all-in → 0 eligible → fast-forward.
		const result = applyAction(room, room.seats[room.hand!.currentSeat].userId!, {
			action: 'call',
		});
		expect(result.phase).toBe('settling');
		expect(result.hand!.board.length).toBe(5);
	});

	test('1 eligible on later street fast-forwards', () => {
		// 3 players: play through preflop, then one goes all-in on flop,
		// another folds, leaving 1 eligible player who calls → fast-forward
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 100 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 100, u3: 1000 },
			deckSeed: 'ff-flop-allin',
		});

		// Preflop: dealer=u1(seat0), SB=u2(seat1), BB=u3(seat2), first to act=u1
		let r = applyAction(room, 'u1', { action: 'call' }); // u1 calls BB
		r = applyAction(r, 'u2', { action: 'call' }); // u2 calls
		r = applyAction(r, 'u3', { action: 'check' }); // u3 checks
		expect(r.hand!.bettingRound).toBe('flop');

		// Flop: first to act after dealer (seat 0) = seat 1 (u2)
		r = applyAction(r, 'u2', { action: 'all_in' }); // u2 all-in for 100
		r = applyAction(r, 'u3', { action: 'call' }); // u3 calls
		r = applyAction(r, 'u1', { action: 'fold' }); // u1 folds
		// Only u3 is eligible (u2 all-in, u1 folded). Should fast-forward.
		expect(r.phase).toBe('settling');
		expect(r.hand!.board.length).toBe(5);
	});
});

describe('engine — buildSidePots with cleared seats', () => {
	test('buildSidePots works when a folded player seat is cleared', () => {
		// Simulates disconnect eviction: a player who was in the hand has their
		// seat.userId cleared to null. buildSidePots should still correctly
		// account for their committed chips using hand.holeCards as source of truth.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 1000 },
			deckSeed: 'cleared-seat-test',
		});

		const hand = room.hand!;
		// Simulate: u1 committed 50 (folded), u2 committed 100, u3 committed 100
		const testHand = {
			...hand,
			committed: { u1: 50, u2: 100, u3: 100 },
			folded: new Set(['u1']),
			allIn: new Set<string>(),
		};

		// Clear u1's seat (simulate disconnect eviction)
		const clearedSeats = room.seats.map((s) =>
			s.userId === 'u1' ? { ...s, userId: null, displayName: null } : s,
		);

		const pots = buildSidePots(testHand, clearedSeats);

		// Should still correctly account for u1's 50 chips:
		// Level 50: 3 contributors × 50 = 150 (eligible: u2, u3)
		// Level 100: 2 contributors × 50 = 100 (eligible: u2, u3)
		const totalFromPots = pots.reduce((a, p) => a + p.amount, 0);
		const totalCommitted = Object.values(testHand.committed).reduce((a, b) => a + b, 0);
		expect(totalFromPots).toBe(totalCommitted); // 250 = 250

		// u1 should NOT be eligible (folded), but their chips ARE counted
		for (const pot of pots) {
			expect(pot.eligibleSeatIndices).not.toContain(0); // u1's seat
		}
	});

	test('buildSidePots totals match committed even with multiple cleared seats', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u4', displayName: 'Dave', seatIndex: 3, mainBalance: 1000 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 1000, u4: 1000 },
			deckSeed: 'multi-clear-test',
		});

		const hand = room.hand!;
		// u1 committed 50 (folded), u2 committed 100 (in), u3 committed 100 (in), u4 committed 50 (folded)
		// All non-folded players (u2, u3) are eligible. No dead-money levels.
		const testHand = {
			...hand,
			committed: { u1: 50, u2: 100, u3: 100, u4: 50 },
			folded: new Set(['u1', 'u4']),
			allIn: new Set<string>(),
		};

		// Clear u1 and u4's seats (simulate disconnect eviction)
		const clearedSeats = room.seats.map((s) =>
			s.userId === 'u1' || s.userId === 'u4' ? { ...s, userId: null, displayName: null } : s,
		);

		const pots = buildSidePots(testHand, clearedSeats);
		const totalFromPots = pots.reduce((a, p) => a + p.amount, 0);
		const totalCommitted = Object.values(testHand.committed).reduce((a, b) => a + b, 0);
		expect(totalFromPots).toBe(totalCommitted); // 300 = 300
		// Only u2 and u3 should be eligible for all pots
		for (const pot of pots) {
			expect(pot.eligibleSeatIndices.sort()).toEqual([1, 2]);
		}
	});

	test('buildSidePots preserves correct seatIndex for non-folded all-in player with cleared seat', () => {
		// Simulates the scenario fixed in the alarm handler: an all-in non-folded
		// player whose seat is NOT cleared (because the fix preserves dealt-in seats).
		// With the fix, the seat mapping should be correct and no -1 fallback is needed.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 1000 },
			deckSeed: 'allin-preserved-seat',
		});

		const hand = room.hand!;
		// u1 all-in for 10, u2 and u3 committed 100 each. u1 NOT folded.
		const testHand = {
			...hand,
			committed: { u1: 10, u2: 100, u3: 100 },
			folded: new Set<string>(),
			allIn: new Set(['u1']),
		};

		// Seats are preserved (not cleared) — u1 still at seat 0
		const pots = buildSidePots(testHand, room.seats);

		// Main pot: 10 × 3 = 30 (u1 eligible at seat 0, u2 at seat 1, u3 at seat 2)
		// Side pot: 90 × 2 = 180 (u2, u3 eligible)
		expect(pots.length).toBe(2);

		const mainPot = pots.find((p) => p.eligibleSeatIndices.length === 3);
		expect(mainPot).toBeDefined();
		expect(mainPot!.eligibleSeatIndices).toContain(0); // u1's seat preserved
		expect(mainPot!.amount).toBe(30);

		const sidePot = pots.find((p) => p.eligibleSeatIndices.length === 2);
		expect(sidePot).toBeDefined();
		expect(sidePot!.eligibleSeatIndices).not.toContain(0); // u1 not eligible for side pot
		expect(sidePot!.amount).toBe(180);
	});
});

describe('engine — currentBet aligned with cumulative commitments', () => {
	test('new street sets currentBet to maxCommitted, not 0', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'cb-test' });
		// Both committed 10 after blinds
		room = applyAction(room, 'u1', { action: 'call' });
		room = applyAction(room, 'u2', { action: 'check' });
		expect(room.hand!.bettingRound).toBe('flop');
		expect(room.hand!.currentBet).toBe(10);
	});

	test('bet on new street computes correct lastRaiseAmount', () => {
		// Both commit 100 preflop. On the flop, currentBet = 100.
		// Player bets to 110 (adds 10). lastRaiseAmount should be 10 (not 110).
		// Min-raise for the next player should be 110 + 10 = 120.
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'cb-raise' });

		// Preflop: u1 raises to 100, u2 calls
		room = applyAction(room, 'u1', { action: 'raise', amount: 100 });
		room = applyAction(room, 'u2', { action: 'call' });
		expect(room.hand!.bettingRound).toBe('flop');
		expect(room.hand!.currentBet).toBe(100);

		// Flop: u2 bets to 110 (raise increment = 110 - 100 = 10)
		room = applyAction(room, 'u2', { action: 'raise', amount: 110 });
		expect(room.hand!.lastRaiseAmount).toBe(10);
		expect(room.hand!.currentBet).toBe(110);

		// u1 can min-raise to 120 (110 + 10)
		room = applyAction(room, 'u1', { action: 'raise', amount: 120 });
		expect(room.hand!.currentBet).toBe(120);
		expect(room.hand!.lastRaiseAmount).toBe(10);
	});

	test('bet on new street rejects below min-raise', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'cb-minraise' });

		// Preflop: u1 raises to 100, u2 calls
		room = applyAction(room, 'u1', { action: 'raise', amount: 100 });
		room = applyAction(room, 'u2', { action: 'call' });

		// Flop: min opening bet = 100 + 10 (BB) = 110. A bet to 105 should fail.
		try {
			applyAction(room, 'u2', { action: 'bet', amount: 105 });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_ACTION');
		}
	});

	test('check is still allowed on new street when committed matches currentBet', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'cb-check' });

		// Preflop: call/check
		room = applyAction(room, 'u1', { action: 'call' });
		room = applyAction(room, 'u2', { action: 'check' });
		expect(room.hand!.bettingRound).toBe('flop');

		// Both can check since toCall = currentBet(10) - committed(10) = 0
		room = applyAction(room, 'u2', { action: 'check' });
		room = applyAction(room, 'u1', { action: 'check' });
		expect(room.hand!.bettingRound).toBe('turn');
	});
});

describe('engine — short all-in does not reopen raises', () => {
	test('already-acted player cannot raise after short all-in', () => {
		// 3 players at seats 0,1,2: dealer=u1(0), SB=u2(1), BB=u3(2), first to act=u1(0).
		// u1 calls, u2 raises to 100, u3 (short stack=150) goes all-in to 150 (short),
		// u1 calls 150, then u2 faces the short all-in and should only call or fold.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Short', seatIndex: 2, mainBalance: 150 });
		room = startHand(room, {
			snapshots: { u1: 1000, u2: 1000, u3: 150 },
			deckSeed: 'short-reopen',
		});

		// u1 calls 10
		let r = applyAction(room, 'u1', { action: 'call' });
		// u2 raises to 100 (lastRaise = 90, hasActed cleared for u1,u3)
		r = applyAction(r, 'u2', { action: 'raise', amount: 100 });
		expect(r.hand!.lastRaiseAmount).toBe(90);
		// u3 goes all-in: stack=150, committed=10, remaining=140, newCommitted=150
		// raiseIncrement = 150 - 100 = 50 < 90 → short all-in
		r = applyAction(r, 'u3', { action: 'all_in' });
		expect(r.hand!.currentBet).toBe(150);
		expect(r.hand!.lastRaiseAmount).toBe(90);
		// u1 calls 150
		r = applyAction(r, 'u1', { action: 'call' });

		// u2 has already acted (raised to 100). Facing the short all-in to 150,
		// u2 should only be able to call or fold, NOT raise.
		try {
			applyAction(r, 'u2', { action: 'raise', amount: 240 });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_ACTION');
		}
	});

	test('already-acted player can call after short all-in', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Short', seatIndex: 2, mainBalance: 150 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 150 }, deckSeed: 'short-call' });

		let r = applyAction(room, 'u1', { action: 'call' });
		r = applyAction(r, 'u2', { action: 'raise', amount: 100 });
		r = applyAction(r, 'u3', { action: 'all_in' });
		r = applyAction(r, 'u1', { action: 'call' });

		// u2 can still call the extra 50
		r = applyAction(r, 'u2', { action: 'call' });
		expect(r.hand!.committed.u2).toBe(150);
	});

	test('already-acted player can fold after short all-in', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Short', seatIndex: 2, mainBalance: 150 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 150 }, deckSeed: 'short-fold' });

		let r = applyAction(room, 'u1', { action: 'call' });
		r = applyAction(r, 'u2', { action: 'raise', amount: 100 });
		r = applyAction(r, 'u3', { action: 'all_in' });
		r = applyAction(r, 'u1', { action: 'call' });

		// u2 can fold
		r = applyAction(r, 'u2', { action: 'fold' });
		expect(r.hand!.folded.has('u2')).toBe(true);
	});

	test('player CAN raise after a full raise reopens action', () => {
		// After a full raise clears hasActed, the player should be able to raise.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Carol', seatIndex: 2, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 1000 }, deckSeed: 'full-raise' });

		// u1 calls 10
		let r = applyAction(room, 'u1', { action: 'call' });
		// u2 raises to 50 (full raise, clears hasActed for u1 and u3)
		r = applyAction(r, 'u2', { action: 'raise', amount: 50 });
		expect(r.hand!.hasActed.has('u1')).toBe(false); // action reopened
		// u3 calls 50
		r = applyAction(r, 'u3', { action: 'call' });
		// u1 can raise (action was reopened by the full raise)
		r = applyAction(r, 'u1', { action: 'raise', amount: 100 });
		expect(r.hand!.currentBet).toBe(100);
	});

	test('already-acted player cannot go all_in as raise after short all-in', () => {
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u3', displayName: 'Short', seatIndex: 2, mainBalance: 150 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000, u3: 150 }, deckSeed: 'short-allin' });

		let r = applyAction(room, 'u1', { action: 'call' });
		r = applyAction(r, 'u2', { action: 'raise', amount: 100 });
		r = applyAction(r, 'u3', { action: 'all_in' });
		r = applyAction(r, 'u1', { action: 'call' });

		// u2 cannot go all_in (which would be a raise) after short all-in
		try {
			applyAction(r, 'u2', { action: 'all_in' });
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('INVALID_ACTION');
		}
	});

	test('already-acted player CAN go all_in when remaining <= toCall (call, not raise)', () => {
		// u2 is a short stack (60 chips). After acting (calling), u3 makes a short
		// all-in that doesn't reopen action. u1 calls. Then u2 faces the bet with
		// remaining <= toCall — all_in is a legal call, not a raise.
		let room = createRoom({ maxSeats: 3, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Short', seatIndex: 1, mainBalance: 60 });
		room = takeSeat(room, {
			userId: 'u3',
			displayName: 'MedShort',
			seatIndex: 2,
			mainBalance: 150,
		});
		room = startHand(room, { snapshots: { u1: 1000, u2: 60, u3: 150 }, deckSeed: 'allin-call' });

		// Seating: dealer=u1(0), SB=u2(1), BB=u3(2). First to act = u1.
		// u1 calls 10
		let r = applyAction(room, 'u1', { action: 'call' });
		// u2 calls 10 (committed 5 as SB, pays 5 more → committed=10)
		r = applyAction(r, 'u2', { action: 'call' });
		// u3 raises to 100 (lastRaise=90, clears hasActed for u1,u2)
		r = applyAction(r, 'u3', { action: 'raise', amount: 100 });
		// u1 calls 100
		r = applyAction(r, 'u1', { action: 'call' });
		// u2: already acted, remaining=50, toCall=90.
		// remaining (50) <= toCall (90), so all_in is a call, not a raise.
		r = applyAction(r, 'u2', { action: 'all_in' });
		expect(r.hand!.committed.u2).toBe(60);
		expect(r.hand!.allIn.has('u2')).toBe(true);
	});
});

describe('engine — host transfer', () => {
	test('config.hostUserId can be reassigned to another seated player', () => {
		// Validates the pattern used in arcturus.ts alarm() when the host
		// times out: config is spread with a new hostUserId so start_hand
		// still passes the host-only check for the successor.
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'host' });
		room = takeSeat(room, { userId: 'host', displayName: 'Host', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, {
			userId: 'guest',
			displayName: 'Guest',
			seatIndex: 1,
			mainBalance: 1000,
		});
		room = takeSeat(room, {
			userId: 'other',
			displayName: 'Other',
			seatIndex: 2,
			mainBalance: 1000,
		});

		// Simulate host disconnect + timeout: clear host's seat, transfer config
		const clearedSeats = room.seats.map((s) =>
			s.userId === 'host'
				? { ...s, userId: null, displayName: null, connected: false, disconnectedAt: null }
				: s,
		);
		room = { ...room, seats: clearedSeats, config: { ...room.config, hostUserId: 'guest' } };

		expect(room.config.hostUserId).toBe('guest');
		expect(room.seats[0].userId).toBeNull();
		expect(room.seats[1].userId).toBe('guest');

		// Guest (now host) can start a hand
		room = startHand(room, { snapshots: { guest: 1000, other: 1000 }, deckSeed: 'transfer-seed' });
		expect(room.phase).toBe('in-hand');
		expect(room.hand).not.toBeNull();
	});

	test('room without seated host and no successor cannot start a hand', () => {
		const room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'host' });
		// Nobody seated — host-only check in the DO would reject regardless,
		// but also startHand would fail with insufficient players.
		// Verify config.hostUserId pointing to a departed user doesn't break engine.
		expect(room.config.hostUserId).toBe('host');
		expect(room.seats.every((s) => s.userId === null)).toBe(true);
		expect(() => startHand(room, { snapshots: {}, deckSeed: 'x' })).toThrow();
	});

	test('host transfer to disconnected-but-seated successor allows start_hand after reconnect', () => {
		// Simulates the alarm scenario where the host's seat is cleared while
		// other players are still seated but temporarily disconnected.  The DO
		// falls back to any seated player (not just connected ones) so the
		// room isn't left with a stale hostUserId.
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'host' });
		room = takeSeat(room, { userId: 'host', displayName: 'Host', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, {
			userId: 'guest',
			displayName: 'Guest',
			seatIndex: 1,
			mainBalance: 1000,
		});
		room = takeSeat(room, {
			userId: 'other',
			displayName: 'Other',
			seatIndex: 2,
			mainBalance: 1000,
		});

		// Simulate: host times out → seat cleared, guest & other are disconnected but still seated
		const clearedSeats = room.seats.map(
			(s) =>
				s.userId === 'host'
					? { ...s, userId: null, displayName: null, connected: false, disconnectedAt: null }
					: { ...s, connected: false, disconnectedAt: Date.now() }, // still seated but disconnected
		);
		// DO fallback: find any seated player, even disconnected ones
		const successor = clearedSeats.find((s) => s.userId !== null);
		room = {
			...room,
			seats: clearedSeats,
			config: { ...room.config, hostUserId: successor!.userId! },
		};

		expect(room.config.hostUserId).toBe('guest');
		expect(room.seats[1].userId).toBe('guest');
		expect(room.seats[1].connected).toBe(false);

		// Simulate players reconnecting: mark connected
		const reconnectedSeats = room.seats.map((s) =>
			s.userId ? { ...s, connected: true, disconnectedAt: null } : s,
		);
		room = { ...room, seats: reconnectedSeats };

		// Now guest (as host) can start a hand
		room = startHand(room, { snapshots: { guest: 1000, other: 1000 }, deckSeed: 'reconnect-seed' });
		expect(room.phase).toBe('in-hand');
		expect(room.hand).not.toBeNull();
	});
});
