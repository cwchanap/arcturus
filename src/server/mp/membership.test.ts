import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import {
	acquireMultiplayerMembership,
	hasActiveRankedSession,
	reconcileMultiplayerMembership,
	type ReconcileMembershipInput,
} from './membership';
import { createRankedTestD1, insertRankedTestUser } from '../ranked/test-d1';

const USER_ID = 'membership-user';
const NOW_MS = 2_000_000_000_999;

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
	({ mf, db } = await createRankedTestD1());
});

afterAll(async () => {
	await mf.dispose();
});

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM ranked_session'),
		db.prepare('DELETE FROM mp_membership'),
		db.prepare('DELETE FROM user'),
	]);
	await insertRankedTestUser(db, { id: USER_ID, chipBalance: 500 });
});

async function seedMembership(roomCode: string, ageMs: number): Promise<void> {
	await db
		.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
		.bind(USER_ID, roomCode, Math.trunc((NOW_MS - ageMs) / 1000))
		.run();
}

async function seedEscrow(heldChips: number): Promise<void> {
	await db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(heldChips, USER_ID).run();
}

async function readMembership(): Promise<{ roomCode: string } | null> {
	return db
		.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?')
		.bind(USER_ID)
		.first<{ roomCode: string }>();
}

async function readBalance(): Promise<{ chipBalance: number; heldChips: number } | null> {
	return db
		.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?')
		.bind(USER_ID)
		.first<{ chipBalance: number; heldChips: number }>();
}

function input({
	probeResult = 'gone',
	allowedRoomCode,
	namespace = {} as DurableObjectNamespace,
}: {
	probeResult?: 'exists' | 'gone' | 'unknown';
	allowedRoomCode?: string;
	namespace?: DurableObjectNamespace;
} = {}): ReconcileMembershipInput {
	return {
		db,
		namespace,
		userId: USER_ID,
		allowedRoomCode,
		nowMs: NOW_MS,
		probe: async () => probeResult,
	};
}

async function seedRankedSession(
	activeUserId: string | null,
	options: { expiresAtSeconds?: number; status?: string } = {},
): Promise<void> {
	const now = Math.trunc(NOW_MS / 1000);
	const expiresAt = options.expiresAtSeconds ?? now + 900;
	const status = options.status ?? (activeUserId === null ? 'settled' : 'active');
	await db
		.prepare(
			`INSERT INTO ranked_session (
				id, userId, startRequestId, startPayloadHash, activeUserId,
				gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
				actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
				status, expiresAt, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'ranked-session',
			USER_ID,
			'ranked-request-0001',
			'start-hash',
			activeUserId,
			'blackjack',
			'blackjack-ranked-v1',
			'{}',
			'config-hash',
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			'seed-commitment',
			'[]',
			'action-log-hash',
			0,
			10,
			10,
			status,
			expiresAt,
			now,
			now,
		)
		.run();
}

async function insertRankedSessionIfNoMembership(): Promise<D1Result> {
	const now = Math.trunc(NOW_MS / 1000);
	return db
		.prepare(
			`INSERT INTO ranked_session (
				id, userId, startRequestId, startPayloadHash, activeUserId,
				gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
				actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
				status, expiresAt, createdAt, updatedAt
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE NOT EXISTS (
				SELECT 1 FROM mp_membership WHERE userId = ?
			)`,
		)
		.bind(
			'ranked-race-session',
			USER_ID,
			'ranked-race-request',
			'start-hash',
			USER_ID,
			'blackjack',
			'blackjack-ranked-v1',
			'{}',
			'config-hash',
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			'seed-commitment',
			'[]',
			'action-log-hash',
			0,
			10,
			10,
			'active',
			now + 900,
			now,
			now,
			USER_ID,
		)
		.run();
}

describe('reconcileMultiplayerMembership', () => {
	test.each(['exists', 'unknown'] as const)('preserves a %s membership', async (probeResult) => {
		await seedMembership('MP-OLD01', 31_000);

		const result = await reconcileMultiplayerMembership(input({ probeResult }));

		expect(result).toEqual({ kind: 'conflict', roomCode: 'MP-OLD01' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-OLD01' });
	});

	test('preserves a membership younger than 30 seconds without trusting a gone probe', async () => {
		await seedMembership('MP-NEW01', 29_000);

		const result = await reconcileMultiplayerMembership(input({ probeResult: 'gone' }));

		expect(result).toEqual({ kind: 'conflict', roomCode: 'MP-NEW01' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-NEW01' });
	});

	test('preserves a truly 29.5-second-old membership stored at whole-second precision', async () => {
		const nowMs = 2_000_000_000_499;
		const actualJoinedAtMs = nowMs - 29_500;
		await db
			.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
			.bind(USER_ID, 'MP-SUBSEC', Math.trunc(actualJoinedAtMs / 1000))
			.run();

		const result = await reconcileMultiplayerMembership({
			...input({ probeResult: 'gone' }),
			nowMs,
		});

		expect(result).toEqual({ kind: 'conflict', roomCode: 'MP-SUBSEC' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-SUBSEC' });
	});

	test('probes and repairs at the exact 30-second boundary', async () => {
		await seedMembership('MP-OLD01', 30_000);

		const result = await reconcileMultiplayerMembership(input({ probeResult: 'gone' }));

		expect(result).toEqual({ kind: 'clear' });
		expect(await readMembership()).toBeNull();
	});

	test('preserves an old membership when the Durable Object namespace is unavailable', async () => {
		await seedMembership('MP-OLD01', 31_000);

		const result = await reconcileMultiplayerMembership({
			db,
			userId: USER_ID,
			nowMs: NOW_MS,
			probe: async () => 'gone',
		});

		expect(result).toEqual({ kind: 'conflict', roomCode: 'MP-OLD01' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-OLD01' });
	});

	test('allows the requested room without probing or replacing its membership', async () => {
		await seedMembership('MP-SAME1', 1_000);

		const result = await reconcileMultiplayerMembership(
			input({ allowedRoomCode: 'MP-SAME1', probeResult: 'gone' }),
		);

		expect(result).toEqual({ kind: 'same-room', roomCode: 'MP-SAME1' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-SAME1' });
	});

	test('releases scoped escrow before deleting a definitively gone membership', async () => {
		await seedMembership('MP-OLD01', 31_000);
		await seedEscrow(500);

		const result = await reconcileMultiplayerMembership(input({ probeResult: 'gone' }));

		expect(result).toEqual({ kind: 'clear' });
		expect(await readBalance()).toEqual({ chipBalance: 1000, heldChips: 0 });
		expect(await readMembership()).toBeNull();
	});

	test('fails closed when held chips have no membership', async () => {
		await seedEscrow(500);

		const result = await reconcileMultiplayerMembership(input());

		expect(result).toEqual({ kind: 'orphaned' });
		expect(await readBalance()).toEqual({ chipBalance: 500, heldChips: 500 });
	});

	test('does not release or delete a concurrently replaced membership', async () => {
		await seedMembership('MP-OLD01', 31_000);
		await seedEscrow(500);
		const replacingProbe: ReconcileMembershipInput['probe'] = async () => {
			await db
				.prepare('UPDATE mp_membership SET roomCode = ?, joinedAt = ? WHERE userId = ?')
				.bind('MP-NEW02', Math.trunc(NOW_MS / 1000), USER_ID)
				.run();
			return 'gone';
		};

		const result = await reconcileMultiplayerMembership({
			...input(),
			probe: replacingProbe,
		});

		expect(result).toEqual({ kind: 'conflict', roomCode: 'MP-NEW02' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-NEW02' });
		expect(await readBalance()).toEqual({ chipBalance: 500, heldChips: 500 });
	});
});

describe('hasActiveRankedSession', () => {
	test('returns true for a non-null activeUserId', async () => {
		await seedRankedSession(USER_ID);

		expect(await hasActiveRankedSession(db, USER_ID, NOW_MS)).toBe(true);
	});

	test('returns false after a ranked session clears activeUserId', async () => {
		await seedRankedSession(null);

		expect(await hasActiveRankedSession(db, USER_ID, NOW_MS)).toBe(false);
	});

	test('returns false when an active-ranked session is past its expiresAt deadline but not yet cleaned up', async () => {
		// Simulate the window between the 15-minute ranked deadline and the
		// hourly runRankedExpiration sweep: status is still 'active' and
		// activeUserId is still set, but expiresAt is in the past.
		const nowSeconds = Math.trunc(NOW_MS / 1000);
		await seedRankedSession(USER_ID, { expiresAtSeconds: nowSeconds - 60 });

		expect(await hasActiveRankedSession(db, USER_ID, NOW_MS)).toBe(false);
	});

	test('returns false when status is expired but activeUserId was not yet NULLed', async () => {
		// Defensive: status takes precedence even if activeUserId is stale.
		await seedRankedSession(USER_ID, { status: 'expired' });

		expect(await hasActiveRankedSession(db, USER_ID, NOW_MS)).toBe(false);
	});
});

describe('acquireMultiplayerMembership', () => {
	test('atomic insert affects zero rows when an active ranked session exists', async () => {
		await seedRankedSession(USER_ID);

		const result = await acquireMultiplayerMembership({
			db,
			userId: USER_ID,
			roomCode: 'MP-BLOCK1',
			joinedAtMs: NOW_MS,
		});

		expect(result).toEqual({ kind: 'blocked' });
		expect(await readMembership()).toBeNull();
	});

	test('allows multiplayer join when ranked session is past expiresAt but not yet cleaned up', async () => {
		// The window between the ranked deadline and the hourly expiration
		// sweep. activeUserId is still set and status is still 'active', but
		// expiresAt is in the past — the user should be allowed to join a
		// multiplayer room without waiting for the cleanup.
		const nowSeconds = Math.trunc(NOW_MS / 1000);
		await seedRankedSession(USER_ID, { expiresAtSeconds: nowSeconds - 60 });

		const result = await acquireMultiplayerMembership({
			db,
			userId: USER_ID,
			roomCode: 'MP-AFTER-EXPIRY',
			joinedAtMs: NOW_MS,
		});

		expect(result).toEqual({ kind: 'acquired', roomCode: 'MP-AFTER-EXPIRY' });
		expect(await readMembership()).toEqual({ roomCode: 'MP-AFTER-EXPIRY' });
	});

	test('concurrent inverse acquisitions allow exactly one ranked or multiplayer owner', async () => {
		const [membershipResult, rankedResult] = await Promise.all([
			acquireMultiplayerMembership({
				db,
				userId: USER_ID,
				roomCode: 'MP-RACE01',
				joinedAtMs: NOW_MS,
			}),
			insertRankedSessionIfNoMembership(),
		]);

		const membership = await readMembership();
		const ranked = await db
			.prepare('SELECT id FROM ranked_session WHERE activeUserId = ?')
			.bind(USER_ID)
			.first<{ id: string }>();
		expect(Number(membership !== null) + Number(ranked !== null)).toBe(1);
		if (membership) {
			expect(membershipResult).toEqual({ kind: 'acquired', roomCode: 'MP-RACE01' });
			expect(rankedResult.meta.changes).toBe(0);
		} else {
			expect(membershipResult).toEqual({ kind: 'blocked' });
			expect(rankedResult.meta.changes).toBe(1);
		}
	});
});
