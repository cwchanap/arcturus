import { describe, expect, test } from 'bun:test';

/**
 * Tests for the per-turn timeout logic in arcturus.ts.
 *
 * The actual DO depends on Cloudflare DO infrastructure (alarms, storage,
 * WebSocket hibernation) and cannot be unit-tested directly.  These tests
 * validate the core decision logic in isolation:
 *
 * 1. scheduleNextAlarm picks the earliest deadline among reconnect timeouts,
 *    idle teardown, turn deadline, pending lock retries, and frozen retries.
 * 2. The alarm handler folds the current actor when turnDeadline <= now.
 * 3. timeRemainingMs is computed from turnDeadline and clamped to [0, ∞).
 */

interface Seat {
	userId: string | null;
	disconnectedAt: number | null;
}

interface Hand {
	currentSeat: number;
}

interface Room {
	phase: 'seating' | 'in-hand' | 'settling' | 'frozen';
	seats: Seat[];
	hand: Hand | null;
}

const RECONNECT_TIMEOUT_MS = 30_000;
const IDLE_TEARDOWN_MS = 5 * 60 * 1000;
const TURN_TIMEOUT_MS = 60_000;

function computeNextAlarmTime(
	room: Room,
	turnDeadline: number | null,
	pendingLockReleasesSize: number,
	pendingEscrowReleasesSize: number,
	now: number,
): number | null {
	let earliest: number | null = null;
	for (const s of room.seats) {
		if (s.disconnectedAt !== null) {
			const fireAt = s.disconnectedAt + RECONNECT_TIMEOUT_MS;
			if (earliest === null || fireAt < earliest) earliest = fireAt;
		}
	}
	const anyHuman = room.seats.some((s) => s.userId !== null);
	if (!anyHuman) {
		const idleFireAt = now + IDLE_TEARDOWN_MS;
		if (earliest === null || idleFireAt < earliest) earliest = idleFireAt;
	}
	if (room.phase === 'in-hand' && room.hand && turnDeadline !== null) {
		if (earliest === null || turnDeadline < earliest) earliest = turnDeadline;
	}
	if (pendingLockReleasesSize > 0 || pendingEscrowReleasesSize > 0) {
		const retryFireAt = now + 10_000;
		if (earliest === null || retryFireAt < earliest) earliest = retryFireAt;
	}
	if (room.phase === 'frozen') {
		const retryFireAt = now + 30_000;
		if (earliest === null || retryFireAt < earliest) earliest = retryFireAt;
	}
	return earliest;
}

function computeTimeRemainingMs(
	phase: Room['phase'],
	hand: Hand | null,
	turnDeadline: number | null,
	now: number,
): number {
	if (phase === 'in-hand' && hand && turnDeadline !== null) {
		return Math.max(0, turnDeadline - now);
	}
	return 0;
}

describe('scheduleNextAlarm: turn deadline priority', () => {
	test('turn deadline is chosen when it is earliest', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'in-hand',
			seats: [{ userId: 'u1', disconnectedAt: null }],
			hand: { currentSeat: 0 },
		};
		const turnDeadline = now + 5_000; // 5s from now
		const result = computeNextAlarmTime(room, turnDeadline, 0, 0, now);
		expect(result).toBe(turnDeadline);
	});

	test('reconnect timeout beats turn deadline when sooner', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'in-hand',
			seats: [
				{ userId: 'u1', disconnectedAt: now - 28_000 }, // reconnect in 2s
				{ userId: 'u2', disconnectedAt: null },
			],
			hand: { currentSeat: 1 },
		};
		const turnDeadline = now + 10_000;
		const result = computeNextAlarmTime(room, turnDeadline, 0, 0, now);
		// reconnect timeout fires at now + 2_000
		expect(result).toBe(now + 2_000);
	});

	test('turn deadline beats idle teardown when room has seated players', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'in-hand',
			seats: [{ userId: 'u1', disconnectedAt: null }],
			hand: { currentSeat: 0 },
		};
		const turnDeadline = now + 10_000;
		const result = computeNextAlarmTime(room, turnDeadline, 0, 0, now);
		// idle teardown would be now + 300_000, but turn deadline is sooner
		expect(result).toBe(turnDeadline);
	});

	test('idle teardown is used when no players seated and no turn deadline', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'seating',
			seats: [{ userId: null, disconnectedAt: null }],
			hand: null,
		};
		const result = computeNextAlarmTime(room, null, 0, 0, now);
		expect(result).toBe(now + IDLE_TEARDOWN_MS);
	});

	test('pending lock release retry beats turn deadline', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'in-hand',
			seats: [{ userId: 'u1', disconnectedAt: null }],
			hand: { currentSeat: 0 },
		};
		const turnDeadline = now + 15_000;
		const result = computeNextAlarmTime(room, turnDeadline, 1, 0, now);
		// pending lock retry at now + 10_000 beats turn deadline
		expect(result).toBe(now + 10_000);
	});

	test('frozen retry beats turn deadline', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'frozen',
			seats: [{ userId: 'u1', disconnectedAt: null }],
			hand: { currentSeat: 0 },
		};
		const turnDeadline = now + 45_000;
		const result = computeNextAlarmTime(room, turnDeadline, 0, 0, now);
		// frozen retry at now + 30_000 beats turn deadline
		expect(result).toBe(now + 30_000);
	});

	test('no alarm when room is seating with humans and no deadlines', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'seating',
			seats: [{ userId: 'u1', disconnectedAt: null }],
			hand: null,
		};
		const result = computeNextAlarmTime(room, null, 0, 0, now);
		expect(result).toBeNull();
	});
});

describe('scheduleNextAlarm: pending escrow release retry', () => {
	test('pending escrow releases trigger alarm even with no other deadlines', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'seating',
			seats: [{ userId: 'u1', disconnectedAt: null }],
			hand: null,
		};
		const result = computeNextAlarmTime(room, null, 0, 2, now);
		expect(result).toBe(now + 10_000);
	});

	test('pending escrow releases combine with pending lock releases', () => {
		const now = 1_000_000;
		const room: Room = {
			phase: 'seating',
			seats: [{ userId: null, disconnectedAt: null }],
			hand: null,
		};
		const result = computeNextAlarmTime(room, null, 1, 1, now);
		expect(result).toBe(now + 10_000);
	});
});

describe('timeRemainingMs computation', () => {
	test('returns remaining time during in-hand with active deadline', () => {
		const now = 1_000_000;
		const turnDeadline = now + 25_000;
		expect(computeTimeRemainingMs('in-hand', { currentSeat: 0 }, turnDeadline, now)).toBe(25_000);
	});

	test('returns 0 when deadline has passed', () => {
		const now = 1_000_000;
		const turnDeadline = now - 5_000;
		expect(computeTimeRemainingMs('in-hand', { currentSeat: 0 }, turnDeadline, now)).toBe(0);
	});

	test('returns 0 when no hand is in play', () => {
		const now = 1_000_000;
		expect(computeTimeRemainingMs('seating', null, now + 10_000, now)).toBe(0);
	});

	test('returns 0 when turnDeadline is null', () => {
		const now = 1_000_000;
		expect(computeTimeRemainingMs('in-hand', { currentSeat: 0 }, null, now)).toBe(0);
	});

	test('returns 0 for settling phase', () => {
		const now = 1_000_000;
		expect(computeTimeRemainingMs('settling', { currentSeat: 0 }, now + 10_000, now)).toBe(0);
	});
});

describe('alarm auto-fold conditions', () => {
	function shouldAutoFold(
		phase: Room['phase'],
		hand: Hand | null,
		turnDeadline: number | null,
		now: number,
		currentSeatUserId: string | null,
		isFolded: boolean,
		isAllIn: boolean,
		isConnected: boolean,
	): boolean {
		if (phase !== 'in-hand' || !hand || turnDeadline === null) return false;
		if (now < turnDeadline) return false;
		if (!currentSeatUserId) return false;
		if (!isConnected) return false;
		if (isFolded || isAllIn) return false;
		return true;
	}

	test('folds when deadline passed and current actor is active', () => {
		expect(
			shouldAutoFold('in-hand', { currentSeat: 0 }, 1000, 2000, 'u1', false, false, true),
		).toBe(true);
	});

	test('does not fold before deadline', () => {
		expect(
			shouldAutoFold('in-hand', { currentSeat: 0 }, 2000, 1000, 'u1', false, false, true),
		).toBe(false);
	});

	test('does not fold when current seat is empty', () => {
		expect(
			shouldAutoFold('in-hand', { currentSeat: 0 }, 1000, 2000, null, false, false, true),
		).toBe(false);
	});

	test('does not fold when player already folded', () => {
		expect(shouldAutoFold('in-hand', { currentSeat: 0 }, 1000, 2000, 'u1', true, false, true)).toBe(
			false,
		);
	});

	test('does not fold when player is all-in', () => {
		expect(shouldAutoFold('in-hand', { currentSeat: 0 }, 1000, 2000, 'u1', false, true, true)).toBe(
			false,
		);
	});

	test('does not fold when player is disconnected', () => {
		expect(
			shouldAutoFold('in-hand', { currentSeat: 0 }, 1000, 2000, 'u1', false, false, false),
		).toBe(false);
	});

	test('does not fold when no hand', () => {
		expect(shouldAutoFold('seating', null, 1000, 2000, 'u1', false, false, true)).toBe(false);
	});

	test('does not fold when turnDeadline is null', () => {
		expect(
			shouldAutoFold('in-hand', { currentSeat: 0 }, null, 2000, 'u1', false, false, true),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test: reconnect sets fresh turnDeadline when player is current actor
//
// When a disconnected player reconnects via handleUpgrade, the turn-deadline
// alarm may have already fired and cleared turnDeadline to null (because the
// player was disconnected at that moment). If the reconnecting player IS the
// current actor, handleUpgrade must set a fresh turnDeadline so a future
// alarm can auto-fold them if they idle. Without this, the hand hangs
// indefinitely.
//
// The production code lives in arcturus.ts handleUpgrade (~line 293).
// ---------------------------------------------------------------------------

describe('reconnect turn deadline restoration', () => {
	const TURN_TIMEOUT_MS = 60_000;

	/**
	 * Simulates the handleUpgrade reconnect logic:
	 * - Player reconnects (connected=true, disconnectedAt=null)
	 * - If phase is 'in-hand', hand exists, and turnDeadline is null or expired:
	 *   check if reconnecting player is the current actor
	 * - If yes, set a fresh turnDeadline
	 */
	function simulateReconnectDeadline(
		phase: Room['phase'],
		hand: Hand | null,
		currentTurnDeadline: number | null,
		currentSeatUserId: string | null,
		reconnectingUserId: string,
		now: number,
	): number | null {
		if (
			phase !== 'in-hand' ||
			!hand ||
			(currentTurnDeadline !== null && currentTurnDeadline > now)
		) {
			return currentTurnDeadline;
		}
		if (currentSeatUserId === reconnectingUserId) {
			return now + TURN_TIMEOUT_MS;
		}
		return currentTurnDeadline;
	}

	test('sets fresh deadline when reconnecting player is current actor and deadline is null', () => {
		const now = 1_000_000;
		const result = simulateReconnectDeadline(
			'in-hand',
			{ currentSeat: 0 },
			null, // deadline was cleared by alarm while player was disconnected
			'u1',
			'u1', // reconnecting user IS the current actor
			now,
		);
		expect(result).toBe(now + TURN_TIMEOUT_MS);
	});

	test('does not set deadline when turnDeadline is in the future', () => {
		const now = 1_000_000;
		const existingDeadline = now + 30_000;
		const result = simulateReconnectDeadline(
			'in-hand',
			{ currentSeat: 0 },
			existingDeadline,
			'u1',
			'u1',
			now,
		);
		// Keep existing deadline — don't overwrite
		expect(result).toBe(existingDeadline);
	});

	test('sets fresh deadline when existing deadline has expired', () => {
		const now = 1_000_000;
		const expiredDeadline = now - 5_000; // expired 5s ago
		const result = simulateReconnectDeadline(
			'in-hand',
			{ currentSeat: 0 },
			expiredDeadline,
			'u1',
			'u1',
			now,
		);
		// Refresh expired deadline so reconnecting actor gets a full turn
		expect(result).toBe(now + TURN_TIMEOUT_MS);
	});

	test('does not set deadline when reconnecting player is not current actor', () => {
		const now = 1_000_000;
		const result = simulateReconnectDeadline(
			'in-hand',
			{ currentSeat: 0 },
			null,
			'u2', // current actor is u2
			'u1', // reconnecting user is u1 (not the actor)
			now,
		);
		expect(result).toBeNull();
	});

	test('does not set deadline when phase is seating', () => {
		const now = 1_000_000;
		const result = simulateReconnectDeadline('seating', null, null, null, 'u1', now);
		expect(result).toBeNull();
	});

	test('does not set deadline when no hand', () => {
		const now = 1_000_000;
		const result = simulateReconnectDeadline('seating', null, null, null, 'u1', now);
		expect(result).toBeNull();
	});

	test('does not set deadline when current seat is empty', () => {
		const now = 1_000_000;
		const result = simulateReconnectDeadline(
			'in-hand',
			{ currentSeat: 2 },
			null,
			null, // empty seat
			'u1',
			now,
		);
		expect(result).toBeNull();
	});

	test('fresh deadline enables future alarm auto-fold', () => {
		// Simulates the full flow:
		// 1. Alarm fires, player is disconnected → deadline cleared
		// 2. Player reconnects → fresh deadline set
		// 3. Next alarm fires after deadline → auto-fold (connected player)
		const now = 1_000_000;

		// Step 2: reconnect sets fresh deadline
		const newDeadline = simulateReconnectDeadline(
			'in-hand',
			{ currentSeat: 0 },
			null,
			'u1',
			'u1',
			now,
		);
		expect(newDeadline).toBe(now + TURN_TIMEOUT_MS);

		// Step 3: verify the auto-fold conditions are met for a connected
		// player whose deadline has passed.  Inline the shouldAutoFold logic
		// (same as the alarm handler in arcturus.ts):
		//   phase === 'in-hand', hand exists, deadline passed, connected, not folded, not all-in
		const phase = 'in-hand';
		const hand: Hand = { currentSeat: 0 };
		const userId = 'u1';
		const isConnected = true;
		const isFolded = false;
		const isAllIn = false;

		const foldable =
			phase === 'in-hand' &&
			hand !== null &&
			newDeadline !== null &&
			now + TURN_TIMEOUT_MS + 1 >= newDeadline &&
			userId !== null &&
			isConnected &&
			!isFolded &&
			!isAllIn;
		expect(foldable).toBe(true);
	});
});

/**
 * Tests for the concurrent settlement guard in runSettlement().
 *
 * When two runSettlement() invocations interleave (DO input gate allows this
 * across await points), one can succeed and clear this.room.hand while the
 * other is still retrying. The losing invocation must NOT freeze the room
 * when the hand is already gone — that would create a frozen room with
 * hand: null that the alarm retry (which checks this.room.hand) cannot
 * self-recover from.
 */
describe('runSettlement freeze guard', () => {
	function shouldFreezeAfterSettlementFailure(hand: Hand | null): boolean {
		// Guard: if another concurrent runSettlement() already settled this
		// hand (cleared it to null), don't re-freeze.
		return hand !== null;
	}

	test('freezes when hand is still present (legitimate failure)', () => {
		expect(shouldFreezeAfterSettlementFailure({ currentSeat: 0 })).toBe(true);
	});

	test('does not freeze when hand is null (already settled by concurrent invocation)', () => {
		expect(shouldFreezeAfterSettlementFailure(null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test: action deadline guard
//
// When a delayed alarm allows a player to send an action after turnDeadline
// has passed, the action handler must check the deadline and auto-fold the
// current actor instead of accepting the late action.
// ---------------------------------------------------------------------------

describe('action deadline guard', () => {
	function shouldRejectActionDueToTimeout(
		phase: Room['phase'],
		hand: Hand | null,
		turnDeadline: number | null,
		now: number,
		currentSeatUserId: string | null,
		actionUserId: string,
	): boolean {
		if (phase !== 'in-hand' || !hand || turnDeadline === null) return false;
		if (now <= turnDeadline) return false;
		return currentSeatUserId === actionUserId;
	}

	test('rejects action when deadline passed and sender is current actor', () => {
		expect(
			shouldRejectActionDueToTimeout('in-hand', { currentSeat: 0 }, 1000, 2000, 'u1', 'u1'),
		).toBe(true);
	});

	test('allows action when deadline not yet passed', () => {
		expect(
			shouldRejectActionDueToTimeout('in-hand', { currentSeat: 0 }, 2000, 1000, 'u1', 'u1'),
		).toBe(false);
	});

	test('allows action when sender is not current actor', () => {
		expect(
			shouldRejectActionDueToTimeout('in-hand', { currentSeat: 0 }, 1000, 2000, 'u2', 'u1'),
		).toBe(false);
	});

	test('allows action when no deadline exists', () => {
		expect(
			shouldRejectActionDueToTimeout('in-hand', { currentSeat: 0 }, null, 2000, 'u1', 'u1'),
		).toBe(false);
	});

	test('allows action when phase is not in-hand', () => {
		expect(shouldRejectActionDueToTimeout('seating', null, 1000, 2000, 'u1', 'u1')).toBe(false);
	});
});
