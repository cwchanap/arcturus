import { roomExists } from '../../lib/mp-poker/roomExists';

const MEMBERSHIP_GRACE_MS = 30_000;

export type MembershipResolution =
	| { kind: 'clear' }
	| { kind: 'same-room'; roomCode: string }
	| { kind: 'conflict'; roomCode: string }
	| { kind: 'orphaned' };

export interface ReconcileMembershipInput {
	db: D1Database;
	namespace?: DurableObjectNamespace;
	userId: string;
	allowedRoomCode?: string;
	nowMs?: number;
	probe?: typeof roomExists;
}

interface MembershipState {
	membership: { roomCode: string; joinedAt: number } | null;
	heldChips: number;
}

async function readMembershipState(db: D1Database, userId: string): Promise<MembershipState> {
	const [membershipResult, balanceResult] = await db.batch([
		db.prepare('SELECT roomCode, joinedAt FROM mp_membership WHERE userId = ?').bind(userId),
		db.prepare('SELECT heldChips FROM user WHERE id = ?').bind(userId),
	]);
	const membership =
		(membershipResult.results[0] as { roomCode: string; joinedAt: number } | undefined) ?? null;
	const balance = balanceResult.results[0] as { heldChips: number } | undefined;
	return {
		membership,
		heldChips: balance?.heldChips ?? 0,
	};
}

function resolutionFromState(state: MembershipState): MembershipResolution {
	if (state.membership) {
		return { kind: 'conflict', roomCode: state.membership.roomCode };
	}
	if (state.heldChips > 0) {
		return { kind: 'orphaned' };
	}
	return { kind: 'clear' };
}

export async function reconcileMultiplayerMembership({
	db,
	namespace,
	userId,
	allowedRoomCode,
	nowMs = Date.now(),
	probe = roomExists,
}: ReconcileMembershipInput): Promise<MembershipResolution> {
	const initial = await readMembershipState(db, userId);
	const membership = initial.membership;

	if (!membership) {
		return initial.heldChips > 0 ? { kind: 'orphaned' } : { kind: 'clear' };
	}
	if (allowedRoomCode === membership.roomCode) {
		return { kind: 'same-room', roomCode: membership.roomCode };
	}

	const membershipAgeMs = nowMs - membership.joinedAt * 1000;
	if (membershipAgeMs < MEMBERSHIP_GRACE_MS) {
		return { kind: 'conflict', roomCode: membership.roomCode };
	}
	if (!namespace) {
		return { kind: 'conflict', roomCode: membership.roomCode };
	}

	const probeResult = await probe(namespace, membership.roomCode);
	if (probeResult !== 'gone') {
		return { kind: 'conflict', roomCode: membership.roomCode };
	}

	const nowSeconds = Math.trunc(nowMs / 1000);
	const [releaseResult, deleteResult] = await db.batch([
		db
			.prepare(
				`UPDATE user SET chipBalance = chipBalance + heldChips, heldChips = 0, updatedAt = ? ` +
					`WHERE id = ? AND heldChips > 0 ` +
					`AND EXISTS (SELECT 1 FROM mp_membership WHERE userId = ? AND roomCode = ?)`,
			)
			.bind(nowSeconds, userId, userId, membership.roomCode),
		db
			.prepare('DELETE FROM mp_membership WHERE userId = ? AND roomCode = ?')
			.bind(userId, membership.roomCode),
	]);

	const releaseChanges = releaseResult.meta.changes ?? 0;
	const deleteChanges = deleteResult.meta.changes ?? 0;
	const finalState = await readMembershipState(db, userId);
	const resolution = resolutionFromState(finalState);

	// Mutation counts are evidence only, never the source of truth. A zero-row
	// release/delete can be caused by a concurrent membership replacement, so
	// every outcome is classified from the post-batch membership and escrow.
	if (releaseChanges === 0 || deleteChanges === 0) {
		return resolution;
	}
	return resolution;
}

export async function hasActiveRankedSession(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS active FROM ranked_session WHERE activeUserId = ? LIMIT 1')
		.bind(userId)
		.first<{ active: number }>();
	return row !== null;
}
