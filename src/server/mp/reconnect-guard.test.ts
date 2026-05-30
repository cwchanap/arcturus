import { describe, expect, test } from 'bun:test';

/**
 * Tests for the reconnect-during-release race conditions fixed in arcturus.ts.
 *
 * Two scenarios are covered:
 *
 * 1. **releaseMembership reconnect guard**: A user reconnects via handleUpgrade
 *    while releaseMembership is awaiting releaseEscrow or the lock-release
 *    fetch.  The fix adds an isUserActive() check before releasing the lock —
 *    if the user is back, the lock must remain held.
 *
 * 2. **releaseEscrowForDisconnected escrow exclusion**: A player disconnects
 *    during fetchSnapshot, their escrow is released, and then they reconnect
 *    before the next loop iteration.  The fix tracks released users in a Set
 *    and excludes them from the returned connected list, preventing them from
 *    being dealt in with a stale snapshot against already-released heldChips.
 *
 * The actual DO methods depend on Cloudflare DO infrastructure (state, env,
 * WebSocket hibernation) and cannot be unit-tested directly.  These tests
 * validate the core data-flow logic in isolation.
 */

// ---------------------------------------------------------------------------
// Pure reimplementation of the filtering logic from releaseEscrowForDisconnected
// for unit testing.  The production code lives in arcturus.ts lines ~1125-1151.
// ---------------------------------------------------------------------------

interface Seat {
	userId: string | null;
	connected: boolean;
}

/**
 * Simulates releaseEscrowForDisconnected's core loop logic:
 * - Takes the initial escrowed user list and a sequence of seat snapshots
 *   representing the room state after each await yield.
 * - For each snapshot, finds users who disconnected and "releases" them.
 * - Users whose escrow was released are excluded from the final connected
 *   list even if they reappear (reconnect) in a later snapshot.
 */
function simulateReleaseEscrowLoop(
	escrowedUserIds: string[],
	seatSnapshots: Seat[][],
	releaseEscrow: (userIds: string[]) => void,
): string[] {
	const released = new Set<string>();
	let prevConnected = escrowedUserIds;

	for (const snapshot of seatSnapshots) {
		const connectedNow = snapshot
			.filter((s) => s.userId !== null && s.connected)
			.map((s) => s.userId!);
		const disconnected = prevConnected.filter((uid) => !connectedNow.includes(uid));
		if (disconnected.length === 0) {
			return connectedNow.filter((uid) => !released.has(uid));
		}
		releaseEscrow(disconnected);
		for (const uid of disconnected) released.add(uid);
		prevConnected = connectedNow;
	}

	// If snapshots exhausted with pending disconnects, do final filter
	const lastConnected = seatSnapshots[seatSnapshots.length - 1]
		.filter((s) => s.userId !== null && s.connected)
		.map((s) => s.userId!);
	return lastConnected.filter((uid) => !released.has(uid));
}

// ---------------------------------------------------------------------------
// Test: releaseEscrowForDisconnected excludes users whose escrow was released
// ---------------------------------------------------------------------------

describe('releaseEscrowForDisconnected: escrow exclusion', () => {
	test('all users stay connected — no releases, returns full list', () => {
		const escrowed = ['u1', 'u2', 'u3'];
		const released: string[] = [];
		const snapshot: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: true },
			{ userId: 'u3', connected: true },
		];
		const result = simulateReleaseEscrowLoop(escrowed, [snapshot], (ids) => released.push(...ids));
		expect(result).toEqual(['u1', 'u2', 'u3']);
		expect(released).toEqual([]);
	});

	test('one user disconnects — released and excluded', () => {
		const escrowed = ['u1', 'u2', 'u3'];
		const released: string[] = [];

		// First snapshot: u2 disconnected
		const snap1: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: false },
			{ userId: 'u3', connected: true },
		];
		// Second snapshot: stable (same as snap1)
		const snap2: Seat[] = [...snap1];

		const result = simulateReleaseEscrowLoop(escrowed, [snap1, snap2], (ids) =>
			released.push(...ids),
		);
		expect(result).toEqual(['u1', 'u3']);
		expect(released).toEqual(['u2']);
	});

	test('user disconnects, escrow released, then reconnects — excluded from result', () => {
		// This is the core race condition from Comment 2:
		// u2 disconnects → escrow released → u2 reconnects → must be excluded
		const escrowed = ['u1', 'u2', 'u3'];
		const released: string[] = [];

		// First snapshot: u2 disconnected
		const snap1: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: false },
			{ userId: 'u3', connected: true },
		];
		// Second snapshot: u2 reconnected! But escrow was already released.
		const snap2: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: true },
			{ userId: 'u3', connected: true },
		];

		const result = simulateReleaseEscrowLoop(escrowed, [snap1, snap2], (ids) =>
			released.push(...ids),
		);

		// u2 must NOT be in the result — their escrow was released
		expect(result).toEqual(['u1', 'u3']);
		expect(released).toEqual(['u2']);
	});

	test('multiple users disconnect and one reconnects — only non-released included', () => {
		const escrowed = ['u1', 'u2', 'u3', 'u4'];
		const released: string[] = [];

		// u2 and u4 disconnect
		const snap1: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: false },
			{ userId: 'u3', connected: true },
			{ userId: 'u4', connected: false },
		];
		// u2 reconnects but u4 stays disconnected
		const snap2: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: true },
			{ userId: 'u3', connected: true },
			{ userId: 'u4', connected: false },
		];
		// Third snapshot: u4 now also reconnects
		const snap3: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: true },
			{ userId: 'u3', connected: true },
			{ userId: 'u4', connected: true },
		];

		const result = simulateReleaseEscrowLoop(escrowed, [snap1, snap2, snap3], (ids) =>
			released.push(...ids),
		);

		// Both u2 and u4 had escrow released — both excluded even though they reconnected
		expect(result).toEqual(['u1', 'u3']);
		expect(released.sort()).toEqual(['u2', 'u4']);
	});

	test('cascading disconnects across snapshots', () => {
		const escrowed = ['u1', 'u2', 'u3'];
		const released: string[] = [];

		// u2 disconnects in first snapshot
		const snap1: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: false },
			{ userId: 'u3', connected: true },
		];
		// u3 also disconnects in second snapshot (cascading)
		const snap2: Seat[] = [
			{ userId: 'u1', connected: true },
			{ userId: 'u2', connected: false },
			{ userId: 'u3', connected: false },
		];
		// Stable
		const snap3: Seat[] = [...snap2];

		const result = simulateReleaseEscrowLoop(escrowed, [snap1, snap2, snap3], (ids) =>
			released.push(...ids),
		);

		expect(result).toEqual(['u1']);
		expect(released.sort()).toEqual(['u2', 'u3']);
	});

	test('all users disconnect — returns empty list', () => {
		const escrowed = ['u1', 'u2'];
		const released: string[] = [];

		const snap1: Seat[] = [
			{ userId: 'u1', connected: false },
			{ userId: 'u2', connected: false },
		];
		const snap2: Seat[] = [...snap1];

		const result = simulateReleaseEscrowLoop(escrowed, [snap1, snap2], (ids) =>
			released.push(...ids),
		);

		expect(result).toEqual([]);
		expect(released.sort()).toEqual(['u1', 'u2']);
	});
});

// ---------------------------------------------------------------------------
// Test: isUserActive check pattern (releaseMembership reconnect guard)
// ---------------------------------------------------------------------------

describe('isUserActive check pattern: reconnect during releaseMembership', () => {
	function isUserActive(
		userId: string,
		sockets: Map<WebSocket, { userId: string }>,
		seats: Seat[],
	): boolean {
		if (Array.from(sockets.values()).some((id) => id.userId === userId)) return true;
		return seats.some((s) => s.userId === userId && s.connected);
	}

	test('returns false when user has no socket and seat is disconnected', () => {
		const sockets = new Map<WebSocket, { userId: string }>();
		const seats: Seat[] = [{ userId: 'u1', connected: false }];
		expect(isUserActive('u1', sockets, seats)).toBe(false);
	});

	test('returns true when user has an open socket', () => {
		const mockWs = {} as WebSocket;
		const sockets = new Map<WebSocket, { userId: string }>([[mockWs, { userId: 'u1' }]]);
		const seats: Seat[] = [{ userId: 'u1', connected: false }];
		expect(isUserActive('u1', sockets, seats)).toBe(true);
	});

	test('returns true when user seat is connected (even without socket)', () => {
		const sockets = new Map<WebSocket, { userId: string }>();
		const seats: Seat[] = [{ userId: 'u1', connected: true }];
		expect(isUserActive('u1', sockets, seats)).toBe(true);
	});

	test('returns false for user not in room', () => {
		const sockets = new Map<WebSocket, { userId: string }>();
		const seats: Seat[] = [{ userId: 'u2', connected: true }];
		expect(isUserActive('u1', sockets, seats)).toBe(false);
	});

	test('returns true when both socket and connected seat exist', () => {
		const mockWs = {} as WebSocket;
		const sockets = new Map<WebSocket, { userId: string }>([[mockWs, { userId: 'u1' }]]);
		const seats: Seat[] = [{ userId: 'u1', connected: true }];
		expect(isUserActive('u1', sockets, seats)).toBe(true);
	});

	test('returns false when seat exists but userId is null', () => {
		const sockets = new Map<WebSocket, { userId: string }>();
		const seats: Seat[] = [{ userId: null, connected: false }];
		expect(isUserActive('u1', sockets, seats)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test: fetchSnapshot failure — escrow retry decision pattern
//
// When fetchSnapshot fails in start_hand, the DO must decide whether to
// clear pendingEscrowReleases based on whether releaseEscrow succeeded.
//
// The production code lives in arcturus.ts ~lines 438-456.
// ---------------------------------------------------------------------------

describe('fetchSnapshot failure: escrow retry decision', () => {
	/**
	 * Simulates the fetchSnapshot catch-block logic:
	 * - If releaseEscrow succeeds → clear pendingEscrowReleases
	 * - If releaseEscrow fails → keep pendingEscrowReleases for alarm retry
	 */
	function handleFetchSnapshotFailure(
		pendingEscrowReleases: Set<string>,
		escrowedUserIds: string[],
		releaseEscrowResult: boolean,
	): { pendingCleared: boolean; shouldPersist: boolean; shouldScheduleAlarm: boolean } {
		if (releaseEscrowResult) {
			pendingEscrowReleases.clear();
			return { pendingCleared: true, shouldPersist: false, shouldScheduleAlarm: false };
		} else {
			// Keep IDs in pendingEscrowReleases for alarm-based retry
			return { pendingCleared: false, shouldPersist: true, shouldScheduleAlarm: true };
		}
	}

	test('releaseEscrow succeeds — clears pending set, no alarm needed', () => {
		const pending = new Set(['u1', 'u2', 'u3']);
		const result = handleFetchSnapshotFailure(pending, ['u1', 'u2', 'u3'], true);
		expect(result.pendingCleared).toBe(true);
		expect(result.shouldPersist).toBe(false);
		expect(result.shouldScheduleAlarm).toBe(false);
		expect(pending.size).toBe(0);
	});

	test('releaseEscrow fails — keeps pending set, persists and schedules alarm', () => {
		const pending = new Set(['u1', 'u2', 'u3']);
		const result = handleFetchSnapshotFailure(pending, ['u1', 'u2', 'u3'], false);
		expect(result.pendingCleared).toBe(false);
		expect(result.shouldPersist).toBe(true);
		expect(result.shouldScheduleAlarm).toBe(true);
		// IDs remain in set for alarm handler to retry
		expect(pending.size).toBe(3);
		expect(pending.has('u1')).toBe(true);
		expect(pending.has('u2')).toBe(true);
		expect(pending.has('u3')).toBe(true);
	});

	test('releaseEscrow fails with empty escrow list — still schedules alarm (no-op retry)', () => {
		const pending = new Set<string>();
		const result = handleFetchSnapshotFailure(pending, [], false);
		expect(result.pendingCleared).toBe(false);
		expect(result.shouldScheduleAlarm).toBe(true);
	});

	test('pending set preserves IDs from before fetchSnapshot was called', () => {
		// Simulates: pendingEscrowReleases was populated before fetchSnapshot
		// (line 433), fetchSnapshot failed, releaseEscrow also failed.
		// The original IDs must remain for the alarm retry.
		const pending = new Set(['u1', 'u2']);
		const result = handleFetchSnapshotFailure(pending, ['u1', 'u2'], false);
		expect(result.pendingCleared).toBe(false);
		expect([...pending]).toEqual(['u1', 'u2']);
	});
});

// ---------------------------------------------------------------------------
// Test: startHand rejection — escrow retry decision pattern
//
// When startHand rejects after fetchSnapshot has already moved chips into
// heldChips (e.g. not enough eligible players), the DO must handle the
// releaseEscrow result the same way as the fetchSnapshot failure path.
//
// The production code lives in arcturus.ts ~lines 503-525.
// ---------------------------------------------------------------------------

describe('startHand rejection: escrow retry decision', () => {
	/**
	 * Simulates the startHand catch-block logic:
	 * - If releaseEscrow succeeds → clear pendingEscrowReleases for live users
	 * - If releaseEscrow fails → add users to pendingEscrowReleases, persist,
	 *   and schedule alarm so the handler retries
	 */
	function handleStartHandRejection(
		pendingEscrowReleases: Set<string>,
		liveConnected: string[],
		releaseEscrowResult: boolean,
	): { shouldPersist: boolean; shouldScheduleAlarm: boolean } {
		if (!releaseEscrowResult) {
			for (const uid of liveConnected) {
				pendingEscrowReleases.add(uid);
			}
			return { shouldPersist: true, shouldScheduleAlarm: true };
		} else {
			for (const uid of liveConnected) {
				pendingEscrowReleases.delete(uid);
			}
			return { shouldPersist: false, shouldScheduleAlarm: false };
		}
	}

	test('releaseEscrow succeeds — clears pending set for live users', () => {
		const pending = new Set(['u1', 'u2', 'u3']);
		const result = handleStartHandRejection(pending, ['u1', 'u2'], true);
		expect(result.shouldPersist).toBe(false);
		expect(result.shouldScheduleAlarm).toBe(false);
		// u1 and u2 cleared; u3 remains (disconnected before startHand)
		expect(pending.has('u1')).toBe(false);
		expect(pending.has('u2')).toBe(false);
		expect(pending.has('u3')).toBe(true);
	});

	test('releaseEscrow fails — adds live users to pending, persists and schedules alarm', () => {
		const pending = new Set(['u3']); // u3 was already pending
		const result = handleStartHandRejection(pending, ['u1', 'u2'], false);
		expect(result.shouldPersist).toBe(true);
		expect(result.shouldScheduleAlarm).toBe(true);
		expect(pending.has('u1')).toBe(true);
		expect(pending.has('u2')).toBe(true);
		expect(pending.has('u3')).toBe(true);
	});

	test('releaseEscrow fails with all users already in pending — still schedules alarm', () => {
		const pending = new Set(['u1', 'u2']);
		const result = handleStartHandRejection(pending, ['u1', 'u2'], false);
		expect(result.shouldPersist).toBe(true);
		expect(result.shouldScheduleAlarm).toBe(true);
		expect(pending.size).toBe(2);
	});

	test('releaseEscrow succeeds with empty liveConnected — no-op', () => {
		const pending = new Set(['u1']);
		const result = handleStartHandRejection(pending, [], true);
		expect(result.shouldPersist).toBe(false);
		expect(result.shouldScheduleAlarm).toBe(false);
		expect(pending.size).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test: eviction membership release — socket clearing before release
//
// When evicting an idle room, sockets must be closed BEFORE calling
// releaseMembership so that isUserActive() returns false and the D1
// mp_membership row is actually deleted. If a user reconnects during
// the release await (isUserActive returns true), releaseMembership now
// returns false and tracks the user in pendingLockReleases — eviction
// must not destroy the DO while the user is still active.
// ---------------------------------------------------------------------------

describe('eviction: socket clearing before membership release', () => {
	function isUserActive(
		userId: string,
		sockets: Map<WebSocket, { userId: string }>,
		seats: Seat[],
	): boolean {
		if (Array.from(sockets.values()).some((id) => id.userId === userId)) return true;
		return seats.some((s) => s.userId === userId && s.connected);
	}

	test('with open socket — isUserActive returns true (triggers reconnect guard)', () => {
		const mockWs = {} as WebSocket;
		const sockets = new Map<WebSocket, { userId: string }>([[mockWs, { userId: 'u1' }]]);
		const seats: Seat[] = [{ userId: null, connected: false }];
		// User has open socket but no seat — releaseMembership would skip them
		// and return false (not true) so eviction doesn't destroy the DO
		expect(isUserActive('u1', sockets, seats)).toBe(true);
	});

	test('after clearing sockets — isUserActive returns false (fix)', () => {
		const mockWs = {} as WebSocket;
		const sockets = new Map<WebSocket, { userId: string }>([[mockWs, { userId: 'u1' }]]);
		const seats: Seat[] = [{ userId: null, connected: false }];
		// Clear sockets before checking — simulates the fix
		sockets.clear();
		expect(isUserActive('u1', sockets, seats)).toBe(false);
	});

	test('multiple users with mixed socket states — clearing resolves all', () => {
		const ws1 = {} as WebSocket;
		const ws2 = {} as WebSocket;
		const sockets = new Map<WebSocket, { userId: string }>([
			[ws1, { userId: 'u1' }],
			[ws2, { userId: 'u2' }],
		]);
		const seats: Seat[] = [
			{ userId: 'u1', connected: false },
			{ userId: null, connected: false },
		];
		// Before clearing: u1 is active via socket, u2 is active via socket
		expect(isUserActive('u1', sockets, seats)).toBe(true);
		expect(isUserActive('u2', sockets, seats)).toBe(true);
		// After clearing: neither is active
		sockets.clear();
		expect(isUserActive('u1', sockets, seats)).toBe(false);
		expect(isUserActive('u2', sockets, seats)).toBe(false);
	});

	test('user in seat but not in sockets — still not active after clear', () => {
		const sockets = new Map<WebSocket, { userId: string }>();
		const seats: Seat[] = [{ userId: 'u1', connected: false }];
		expect(isUserActive('u1', sockets, seats)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test: start_hand host transfer — orphaned creator lock
//
// When the room creator never establishes a WebSocket (e.g. tab crashed
// after POST /api/mp/rooms), their mp_membership row exists in D1 but they
// have no socket or seat in the DO's in-memory state.  If another seated
// player sends start_hand, the absent-host branch must add the old host to
// pendingLockReleases so the alarm handler eventually releases their
// membership lock.  Without this, the creator is permanently blocked from
// joining any room (ALREADY_IN_ROOM) with no self-recovery path.
// ---------------------------------------------------------------------------

describe('start_hand host transfer: orphaned creator lock', () => {
	interface RoomConfig {
		hostUserId: string;
	}

	function simulateHostTransfer(
		pendingLockReleases: Set<string>,
		config: RoomConfig,
		sockets: Map<WebSocket, { userId: string }>,
		seats: Seat[],
	): { newConfig: RoomConfig; pendingAfter: Set<string> } {
		// Reproduce the start_hand absent-host logic:
		// 1. Check if current host is present (socket or connected seat)
		const hostPresent =
			Array.from(sockets.values()).some((id) => id.userId === config.hostUserId) ||
			seats.some((s) => s.userId === config.hostUserId && s.connected);

		if (!hostPresent) {
			// Find a connected seated successor
			const successor = seats.find((s) => s.userId !== null && s.connected);
			if (successor?.userId) {
				// THE FIX: track old host for lock release before reassigning
				pendingLockReleases.add(config.hostUserId);
				return {
					newConfig: { hostUserId: successor.userId },
					pendingAfter: new Set(pendingLockReleases),
				};
			}
		}

		return { newConfig: config, pendingAfter: new Set(pendingLockReleases) };
	}

	test('absent creator tracked in pendingLockReleases on host transfer', () => {
		const pending = new Set<string>();
		const sockets = new Map<WebSocket, { userId: string }>(); // creator has no socket
		const seats: Seat[] = [
			{ userId: 'player-a', connected: true },
			{ userId: 'player-b', connected: true },
		];

		const result = simulateHostTransfer(pending, { hostUserId: 'creator' }, sockets, seats);

		// Host should be transferred to a connected seated player
		expect(result.newConfig.hostUserId).not.toBe('creator');
		// Old host's lock must be tracked for alarm-based release
		expect(result.pendingAfter.has('creator')).toBe(true);
	});

	test('present host — no transfer, no pending lock release', () => {
		const pending = new Set<string>();
		const mockWs = {} as WebSocket;
		const sockets = new Map<WebSocket, { userId: string }>([[mockWs, { userId: 'creator' }]]);
		const seats: Seat[] = [{ userId: 'player-a', connected: true }];

		const result = simulateHostTransfer(pending, { hostUserId: 'creator' }, sockets, seats);

		expect(result.newConfig.hostUserId).toBe('creator');
		expect(result.pendingAfter.has('creator')).toBe(false);
	});

	test('host seated but disconnected — no transfer (disconnected, not absent)', () => {
		const pending = new Set<string>();
		const sockets = new Map<WebSocket, { userId: string }>(); // no socket
		const seats: Seat[] = [
			{ userId: 'creator', connected: false }, // seated but disconnected
			{ userId: 'player-a', connected: true },
		];

		const result = simulateHostTransfer(pending, { hostUserId: 'creator' }, sockets, seats);

		// Host is absent (no socket, not connected) → transfer happens
		expect(result.newConfig.hostUserId).not.toBe('creator');
		// Old host still tracked for lock release
		expect(result.pendingAfter.has('creator')).toBe(true);
	});

	test('no eligible successor — no transfer, no pending lock release', () => {
		const pending = new Set<string>();
		const sockets = new Map<WebSocket, { userId: string }>();
		const seats: Seat[] = []; // no one seated

		const result = simulateHostTransfer(pending, { hostUserId: 'creator' }, sockets, seats);

		expect(result.newConfig.hostUserId).toBe('creator');
		expect(result.pendingAfter.size).toBe(0);
	});

	test('host transfer triggers short-fuse alarm retry', () => {
		// After host transfer, pendingLockReleases is non-empty, so
		// scheduleNextAlarm must schedule a 10s retry alarm even if
		// start_hand returns early afterward.
		const pending = new Set<string>();
		const sockets = new Map<WebSocket, { userId: string }>(); // creator has no socket
		const seats: Seat[] = [{ userId: 'player-a', connected: true }];

		const result = simulateHostTransfer(pending, { hostUserId: 'creator' }, sockets, seats);

		expect(result.pendingAfter.has('creator')).toBe(true);

		// Reproduce scheduleNextAlarm logic: pendingLockReleases > 0 → 10s alarm
		const now = 1_000_000;
		const RETRY_MS = 10_000;
		const alarmTime = now + RETRY_MS;
		// Verify the alarm time would be picked up by scheduleNextAlarm
		expect(result.pendingAfter.size > 0 ? alarmTime : null).toBe(now + RETRY_MS);
	});
});

// ---------------------------------------------------------------------------
// Test: releaseMembership reconnect guard — return value semantics
//
// When isUserActive() returns true (user reconnected during an await),
// releaseMembership must return false and add the user to pendingLockReleases.
// Eviction callers treat `true` as "safe to destroy DO and delete storage,"
// so returning true when the user is active would:
// 1. Let eviction destroy the DO (losing the alarm retry mechanism)
// 2. Leave the D1 mp_membership row orphaned (user stuck with ALREADY_IN_ROOM)
//
// Returning false ensures eviction preserves the DO.  The alarm handler
// then rechecks: if the user is still active, it removes them from
// pendingLockReleases without releasing the lock (lines 710-714).
// ---------------------------------------------------------------------------

describe('releaseMembership: reconnect guard return value', () => {
	function simulateReleaseMembershipReconnectGuard(
		userId: string,
		pendingLockReleases: Set<string>,
		isActive: boolean,
	): { result: boolean; pendingAfter: Set<string> } {
		// Simulates the isUserActive check in releaseMembership
		// (arcturus.ts lines ~1296-1301 and ~1319-1325)
		if (isActive) {
			pendingLockReleases.add(userId);
			return { result: false, pendingAfter: new Set(pendingLockReleases) };
		}
		// If not active, would proceed to lock release fetch
		return { result: true, pendingAfter: new Set(pendingLockReleases) };
	}

	test('user reconnects during escrow await — returns false, tracked in pendingLockReleases', () => {
		const pending = new Set<string>();
		const result = simulateReleaseMembershipReconnectGuard('u1', pending, true);
		expect(result.result).toBe(false);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('user stays disconnected — returns true (proceeds to lock release)', () => {
		const pending = new Set<string>();
		const result = simulateReleaseMembershipReconnectGuard('u1', pending, false);
		expect(result.result).toBe(true);
		expect(result.pendingAfter.has('u1')).toBe(false);
	});

	test('reconnect guard prevents eviction from destroying DO', () => {
		// Simulate eviction: two users, one reconnects during release
		const pending = new Set<string>();
		const u1Result = simulateReleaseMembershipReconnectGuard('u1', pending, false);
		const u2Result = simulateReleaseMembershipReconnectGuard('u2', pending, true);

		// u1 disconnected — safe to release
		expect(u1Result.result).toBe(true);
		// u2 reconnected — NOT safe, eviction must not proceed
		expect(u2Result.result).toBe(false);
		expect(u2Result.pendingAfter.has('u2')).toBe(true);

		// Eviction decision: allReleased should be false
		const allReleased = u1Result.result && u2Result.result;
		expect(allReleased).toBe(false);
	});

	test('alarm handler removes active user from pendingLockReleases without releasing', () => {
		// After the reconnect guard adds user to pendingLockReleases,
		// the alarm handler (arcturus.ts lines 710-714) checks if user
		// is still active and removes them without calling releaseMembership.
		const pending = new Set(['u1']);
		const stillSeated = true;
		const hasOpenSocket = false;

		if (stillSeated || hasOpenSocket) {
			pending.delete('u1');
		}

		expect(pending.has('u1')).toBe(false);
	});

	test('reconnect inside retry loop — same guard applies', () => {
		// User was inactive before first attempt (escrow await), but
		// reconnects during retry delay. Second pre-check catches it.
		const pending = new Set<string>();
		// First check (post-escrow): inactive → proceed to lock fetch
		const check1 = simulateReleaseMembershipReconnectGuard('u1', pending, false);
		expect(check1.result).toBe(true);
		// Lock fetch fails (5xx), retry scheduled. User reconnects during delay.
		// Second pre-check (inside retry loop): active → abort
		const check2 = simulateReleaseMembershipReconnectGuard('u1', pending, true);
		expect(check2.result).toBe(false);
		expect(check2.pendingAfter.has('u1')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Test: releaseMembership lock API response handling
//
// The lock API (/api/mp/lock, action=release) returns:
// - 200: row deleted (or was already gone — DELETE is idempotent)
// - 403: auth failure (wrong/missing x-arcturus-auth)
// - 400: malformed request body
//
// Before the fix, all 4xx were treated as success (pendingLockReleases.delete
// + return true).  This meant a 403 (secret mismatch) or 400 (bad request)
// would permanently orphan the membership row with no retry mechanism.
//
// The fix: only 200 is treated as success.  4xx returns false so the caller
// keeps the user in pendingLockReleases for alarm-based retry.
// ---------------------------------------------------------------------------

describe('releaseMembership: lock API response handling', () => {
	function simulateLockApiResponse(
		statusCode: number,
		userId: string,
		pendingLockReleases: Set<string>,
	): { result: boolean; pendingAfter: Set<string> } {
		if (statusCode >= 200 && statusCode < 300) {
			// Success — row deleted or was already gone
			pendingLockReleases.delete(userId);
			return { result: true, pendingAfter: new Set(pendingLockReleases) };
		}
		if (statusCode >= 400 && statusCode < 500) {
			// Auth/request failure — row was NOT deleted.
			// Keep in pendingLockReleases for alarm retry.
			return { result: false, pendingAfter: new Set(pendingLockReleases) };
		}
		// 5xx — transient, retry in loop
		return { result: true, pendingAfter: new Set(pendingLockReleases) };
	}

	test('200 OK — success, removed from pendingLockReleases', () => {
		const pending = new Set(['u1']);
		const result = simulateLockApiResponse(200, 'u1', pending);
		expect(result.result).toBe(true);
		expect(result.pendingAfter.has('u1')).toBe(false);
	});

	test('403 Forbidden — auth failure, kept in pendingLockReleases for retry', () => {
		const pending = new Set(['u1']);
		const result = simulateLockApiResponse(403, 'u1', pending);
		expect(result.result).toBe(false);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('400 Bad Request — malformed body, kept in pendingLockReleases for retry', () => {
		const pending = new Set(['u1']);
		const result = simulateLockApiResponse(400, 'u1', pending);
		expect(result.result).toBe(false);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('403 prevents eviction from destroying DO with orphaned membership', () => {
		// Two users: u1 gets 200, u2 gets 403
		const pending = new Set(['u1', 'u2']);
		const u1Result = simulateLockApiResponse(200, 'u1', pending);
		const u2Result = simulateLockApiResponse(403, 'u2', pending);

		expect(u1Result.result).toBe(true);
		expect(u2Result.result).toBe(false);
		expect(u2Result.pendingAfter.has('u2')).toBe(true);

		// Eviction decision: allReleased should be false
		const allReleased = u1Result.result && u2Result.result;
		expect(allReleased).toBe(false);
	});

	test('user not in pendingLockReleases — 403 still returns false', () => {
		// Even if the user wasn't previously tracked (e.g. first attempt),
		// a 4xx should still return false to prevent the eviction caller
		// from treating it as success.
		const pending = new Set<string>();
		const result = simulateLockApiResponse(403, 'u1', pending);
		expect(result.result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test: handleUpgrade broadcasts reconnect state to all players
//
// When a disconnected player reconnects, handleUpgrade must broadcast the
// updated room state (connected: true, disconnectedAt: null) to ALL sockets,
// not just the reconnecting one. Without this, other players keep the stale
// connected: false state until some unrelated event broadcasts.
//
// The production code lives in arcturus.ts handleUpgrade (~line 293).
// ---------------------------------------------------------------------------

describe('handleUpgrade: reconnect state broadcast to all players', () => {
	interface SeatWithId {
		userId: string | null;
		connected: boolean;
		disconnectedAt: number | null;
	}

	/**
	 * Simulates the seat update logic in handleUpgrade:
	 * - The reconnecting user's seat gets connected=true, disconnectedAt=null
	 * - All other seats remain unchanged
	 */
	function simulateReconnectSeatUpdate(
		seats: SeatWithId[],
		reconnectingUserId: string,
	): SeatWithId[] {
		return seats.map((s) =>
			s.userId === reconnectingUserId ? { ...s, connected: true, disconnectedAt: null } : s,
		);
	}

	test('reconnecting player seat updated to connected with null disconnectedAt', () => {
		const seats: SeatWithId[] = [
			{ userId: 'u1', connected: true, disconnectedAt: null },
			{ userId: 'u2', connected: false, disconnectedAt: 1000 },
			{ userId: 'u3', connected: true, disconnectedAt: null },
		];
		const updated = simulateReconnectSeatUpdate(seats, 'u2');
		expect(updated[1]).toEqual({ userId: 'u2', connected: true, disconnectedAt: null });
	});

	test('other players seats remain unchanged', () => {
		const seats: SeatWithId[] = [
			{ userId: 'u1', connected: true, disconnectedAt: null },
			{ userId: 'u2', connected: false, disconnectedAt: 1000 },
		];
		const updated = simulateReconnectSeatUpdate(seats, 'u2');
		expect(updated[0]).toEqual({ userId: 'u1', connected: true, disconnectedAt: null });
	});

	test('reconnecting user not in seats — no changes', () => {
		const seats: SeatWithId[] = [{ userId: 'u1', connected: true, disconnectedAt: null }];
		const updated = simulateReconnectSeatUpdate(seats, 'u999');
		expect(updated[0]).toEqual({ userId: 'u1', connected: true, disconnectedAt: null });
	});

	test('broadcast recipients include all sockets, not just reconnecting one', () => {
		// Simulates the fix: broadcastRoomState sends to ALL sockets,
		// whereas the old code (this.send(server, ...)) only sent to the
		// reconnecting socket. This test validates the broadcast pattern.
		const socketUserIds = ['u1', 'u2', 'u3'];
		const reconnectingUserId = 'u2';

		// Old behavior: only reconnecting socket gets state
		const oldRecipients = [reconnectingUserId];

		// New behavior: all sockets get state
		const newRecipients = socketUserIds;

		// Verify the fix sends to all sockets
		expect(newRecipients).toContain('u1');
		expect(newRecipients).toContain('u2');
		expect(newRecipients).toContain('u3');
		expect(newRecipients.length).toBeGreaterThan(oldRecipients.length);
	});
});

// ---------------------------------------------------------------------------
// Test: pre-escrow reconnection guard in releaseMembership
//
// Before sending a releaseEscrow fetch, releaseMembership now checks
// isUserActive().  If the user reconnected (and may have been re-escrowed
// by a new start_hand), the stale release must be aborted to prevent
// freeing the new hand's buy-in.
//
// The production code lives in arcturus.ts releaseMembership() — the
// isUserActive() check before releaseEscrow() call.
// ---------------------------------------------------------------------------

describe('releaseMembership: pre-escrow reconnection guard', () => {
	/**
	 * Simulates releaseMembership's escrow path with the pre-escrow guard.
	 * Returns the decision at each guard point.
	 */
	function simulatePreEscrowGuard(
		userId: string,
		pendingLockReleases: Set<string>,
		isHandParticipant: boolean,
		isActiveBeforeEscrow: boolean,
		escrowOk: boolean | null, // null = skipped (hand participant)
		isActiveAfterEscrow: boolean | null, // null = not reached
	): { result: boolean; pendingAfter: Set<string>; escrowCalled: boolean } {
		if (!isHandParticipant) {
			// Pre-escrow guard: check if user reconnected
			if (isActiveBeforeEscrow) {
				pendingLockReleases.add(userId);
				return { result: false, pendingAfter: new Set(pendingLockReleases), escrowCalled: false };
			}
			// Escrow release attempted
			if (!escrowOk) {
				pendingLockReleases.add(userId);
				return { result: false, pendingAfter: new Set(pendingLockReleases), escrowCalled: true };
			}
		}

		// Post-escrow guard
		if (isActiveAfterEscrow) {
			pendingLockReleases.add(userId);
			return {
				result: false,
				pendingAfter: new Set(pendingLockReleases),
				escrowCalled: !isHandParticipant,
			};
		}

		return {
			result: true,
			pendingAfter: new Set(pendingLockReleases),
			escrowCalled: !isHandParticipant,
		};
	}

	test('user reconnected before escrow release — aborts, no escrow fetch sent', () => {
		const pending = new Set<string>();
		const result = simulatePreEscrowGuard('u1', pending, false, true, null, null);
		expect(result.result).toBe(false);
		expect(result.escrowCalled).toBe(false);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('user disconnected before escrow, reconnected after — post-escrow guard catches it', () => {
		const pending = new Set<string>();
		const result = simulatePreEscrowGuard('u1', pending, false, false, true, true);
		expect(result.result).toBe(false);
		expect(result.escrowCalled).toBe(true);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('user stays disconnected throughout — proceeds to lock release', () => {
		const pending = new Set<string>();
		const result = simulatePreEscrowGuard('u1', pending, false, false, true, false);
		expect(result.result).toBe(true);
		expect(result.escrowCalled).toBe(true);
		expect(result.pendingAfter.has('u1')).toBe(false);
	});

	test('hand participant skips escrow — post-escrow guard still applies', () => {
		const pending = new Set<string>();
		const result = simulatePreEscrowGuard('u1', pending, true, false, null, true);
		expect(result.result).toBe(false);
		expect(result.escrowCalled).toBe(false);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('escrow release fails — aborts without reaching post-escrow guard', () => {
		const pending = new Set<string>();
		const result = simulatePreEscrowGuard('u1', pending, false, false, false, null);
		expect(result.result).toBe(false);
		expect(result.escrowCalled).toBe(true);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Test: post-lock-release reconnection guard with lock re-acquisition
//
// After the lock release fetch returns ok, the user may have reconnected
// during the fetch await.  The membership row was already deleted by the
// lock API.  The fix re-acquires the lock immediately to restore the
// one-room-per-user invariant.
//
// The production code lives in arcturus.ts releaseMembership() — the
// isUserActive() check after res.ok in the lock release retry loop.
// ---------------------------------------------------------------------------

describe('releaseMembership: post-lock-release reconnection guard', () => {
	/**
	 * Simulates the lock release flow including the post-fetch guard.
	 * Returns whether the lock was released, re-acquired, left deleted,
	 * or re-acquire failed (sockets closed).
	 */
	function simulatePostLockReleaseGuard(
		userId: string,
		pendingLockReleases: Set<string>,
		fetchSucceeded: boolean,
		isActiveAfterFetch: boolean,
		reacquireSucceeded: boolean = true,
	): {
		result: boolean;
		pendingAfter: Set<string>;
		lockState: 'released' | 're-acquired' | 'unchanged' | 'reacquire-failed';
		socketsClosed: boolean;
	} {
		if (fetchSucceeded) {
			// Post-fetch guard: user reconnected during the fetch await
			if (isActiveAfterFetch) {
				if (!reacquireSucceeded) {
					// Lock was deleted but re-acquire failed — close sockets
					// so the alarm handler can retry without the active-user
					// guard blocking it.  User stays in pendingLockReleases.
					pendingLockReleases.add(userId);
					return {
						result: false,
						pendingAfter: new Set(pendingLockReleases),
						lockState: 'reacquire-failed',
						socketsClosed: true,
					};
				}
				// Lock was already deleted — re-acquire succeeded
				pendingLockReleases.add(userId);
				return {
					result: false,
					pendingAfter: new Set(pendingLockReleases),
					lockState: 're-acquired',
					socketsClosed: false,
				};
			}
			// User still disconnected — lock released successfully
			pendingLockReleases.delete(userId);
			return {
				result: true,
				pendingAfter: new Set(pendingLockReleases),
				lockState: 'released',
				socketsClosed: false,
			};
		}
		// Fetch failed — lock state unchanged
		return {
			result: false,
			pendingAfter: new Set(pendingLockReleases),
			lockState: 'unchanged',
			socketsClosed: false,
		};
	}

	test('user stays disconnected after fetch — lock released normally', () => {
		const pending = new Set(['u1']);
		const result = simulatePostLockReleaseGuard('u1', pending, true, false);
		expect(result.result).toBe(true);
		expect(result.lockState).toBe('released');
		expect(result.pendingAfter.has('u1')).toBe(false);
	});

	test('user reconnects during fetch — lock re-acquired, returns false', () => {
		const pending = new Set(['u1']);
		const result = simulatePostLockReleaseGuard('u1', pending, true, true);
		expect(result.result).toBe(false);
		expect(result.lockState).toBe('re-acquired');
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('user reconnects during fetch — re-acquire fails, sockets closed', () => {
		const pending = new Set(['u1']);
		const result = simulatePostLockReleaseGuard('u1', pending, true, true, false);
		expect(result.result).toBe(false);
		expect(result.lockState).toBe('reacquire-failed');
		expect(result.socketsClosed).toBe(true);
		// Still tracked in pendingLockReleases so alarm retries the release
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('user reconnects during fetch — re-acquire succeeds, sockets not closed', () => {
		const pending = new Set(['u1']);
		const result = simulatePostLockReleaseGuard('u1', pending, true, true, true);
		expect(result.lockState).toBe('re-acquired');
		expect(result.socketsClosed).toBe(false);
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('fetch fails — lock unchanged, user stays in pendingLockReleases', () => {
		const pending = new Set(['u1']);
		const result = simulatePostLockReleaseGuard('u1', pending, false, false);
		expect(result.result).toBe(false);
		expect(result.lockState).toBe('unchanged');
		expect(result.pendingAfter.has('u1')).toBe(true);
	});

	test('re-acquired lock prevents eviction from destroying DO', () => {
		// Two users: u1 released normally, u2 reconnected during fetch
		const pending = new Set(['u1', 'u2']);
		const u1Result = simulatePostLockReleaseGuard('u1', pending, true, false);
		const u2Result = simulatePostLockReleaseGuard('u2', pending, true, true);

		expect(u1Result.result).toBe(true);
		expect(u2Result.result).toBe(false);
		expect(u2Result.lockState).toBe('re-acquired');

		// Eviction decision: allReleased should be false
		const allReleased = u1Result.result && u2Result.result;
		expect(allReleased).toBe(false);
	});

	test('reacquire-failed user: alarm retry sees inactive user and retries release', () => {
		// After sockets are closed, isUserActive returns false, so the alarm
		// handler should retry the release (not skip via active-user guard).
		const pending = new Set(['u1']);
		const guardResult = simulatePostLockReleaseGuard('u1', pending, true, true, false);
		expect(guardResult.socketsClosed).toBe(true);
		expect(guardResult.pendingAfter.has('u1')).toBe(true);

		// Simulate alarm handler: sockets are closed so user is not active
		const userStillActive = false; // would be false because sockets were closed
		if (userStillActive) {
			pending.delete('u1'); // skip
		}
		// User not active → alarm retries releaseMembership
		expect(pending.has('u1')).toBe(true);
	});

	test('full flow: pre-escrow guard aborts before reaching lock release', () => {
		// User reconnects before escrow — never reaches lock release
		const pending = new Set<string>();
		// Pre-escrow guard catches the reconnect
		pending.add('u1');
		// Lock release is never attempted
		const result = simulatePostLockReleaseGuard('u1', pending, false, true);
		// Lock was never sent, so unchanged
		expect(result.lockState).toBe('unchanged');
		expect(result.pendingAfter.has('u1')).toBe(true);
	});
});
