import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { lockBodySchema, POST } from '../../pages/api/mp/lock';
import {
	createRankedTestD1,
	insertRankedSession,
	insertRankedTestUser,
	installRankedAfterStaleDelete as installRankedAfterStaleDeleteHelper,
} from '../ranked/test-d1';

const USER_ID = 'lock-user';
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
		db.prepare('DROP TRIGGER IF EXISTS delete_lock_after_insert'),
		db.prepare('DROP TRIGGER IF EXISTS lock_ranked_after_stale_delete'),
		db.prepare('DELETE FROM ranked_session'),
		db.prepare('DELETE FROM mp_membership'),
		db.prepare('DELETE FROM user'),
	]);
	await insertRankedTestUser(db, { id: USER_ID, chipBalance: 500 });
});

function makeAcquireRequest(roomCode: string): Request {
	return new Request('http://test.local/api/mp/lock', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'acquire', roomCode }),
	});
}

function makeLocals(namespace?: DurableObjectNamespace) {
	return {
		user: { id: USER_ID },
		runtime: {
			env: {
				DB: db,
				arcturus: namespace,
			},
		},
	};
}

async function seedActiveRankedSession(): Promise<void> {
	await insertRankedSession(db, {
		id: 'lock-ranked-session',
		userId: USER_ID,
		startRequestId: 'lock-ranked-request',
		activeUserId: USER_ID,
	});
}

async function installRankedAfterStaleDelete(): Promise<void> {
	await installRankedAfterStaleDeleteHelper(db, {
		userId: USER_ID,
		roomCode: 'MP-OLD01',
		sessionId: 'lock-race-ranked',
		startRequestId: 'lock-race-request',
		triggerName: 'lock_ranked_after_stale_delete',
	});
}

describe('lockBodySchema', () => {
	test('accepts valid acquire with roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire', roomCode: 'ABCD' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.action).toBe('acquire');
			expect(result.data.roomCode).toBe('ABCD');
		}
	});

	test('rejects acquire without roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire' });
		expect(result.success).toBe(false);
	});

	test('rejects acquire with empty roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire', roomCode: '' });
		expect(result.success).toBe(false);
	});

	test('accepts valid release with roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'release', roomCode: 'ABCD' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.action).toBe('release');
			expect(result.data.roomCode).toBe('ABCD');
		}
	});

	test('rejects release without roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'release' });
		expect(result.success).toBe(false);
	});

	test('rejects release with empty roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'release', roomCode: '' });
		expect(result.success).toBe(false);
	});

	test('rejects invalid action', () => {
		const result = lockBodySchema.safeParse({ action: 'destroy' });
		expect(result.success).toBe(false);
	});

	test('rejects missing action', () => {
		const result = lockBodySchema.safeParse({ roomCode: 'ABCD' });
		expect(result.success).toBe(false);
	});

	test('rejects non-string action', () => {
		const result = lockBodySchema.safeParse({ action: 42 });
		expect(result.success).toBe(false);
	});

	test('rejects non-string roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire', roomCode: 123 });
		expect(result.success).toBe(false);
	});

	test('rejects empty object', () => {
		const result = lockBodySchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test('rejects null', () => {
		const result = lockBodySchema.safeParse(null);
		expect(result.success).toBe(false);
	});
});

describe('mp/lock membership acquisition', () => {
	test('allows re-acquiring the same room membership', async () => {
		const joinedAt = Math.trunc(Date.now() / 1000);
		await db
			.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
			.bind(USER_ID, 'MP-SAME1', joinedAt)
			.run();

		const response = await POST({
			request: makeAcquireRequest('MP-SAME1'),
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toEqual({ roomCode: 'MP-SAME1' });
	});

	test('releases escrow before replacing a definitively gone membership', async () => {
		const oldJoinedAt = Math.trunc((Date.now() - 31_000) / 1000);
		await db.batch([
			db
				.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
				.bind(USER_ID, 'MP-OLD01', oldJoinedAt),
			db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(500, USER_ID),
		]);
		const goneNamespace = {
			idFromName: () => ({}) as DurableObjectId,
			get: () => ({
				fetch: async () => new Response(null, { status: 404 }),
			}),
		} as unknown as DurableObjectNamespace;

		const response = await POST({
			request: makeAcquireRequest('MP-NEW02'),
			locals: makeLocals(goneNamespace) as any,
		} as any);

		expect(response.status).toBe(200);
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toEqual({ roomCode: 'MP-NEW02' });
		expect(
			await db
				.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?')
				.bind(USER_ID)
				.first(),
		).toEqual({ chipBalance: 1000, heldChips: 0 });
	});

	test('rejects acquisition while the user has an active ranked session', async () => {
		await seedActiveRankedSession();

		const response = await POST({
			request: makeAcquireRequest('MP-NEW01'),
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'ALREADY_IN_ROOM' });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toBeNull();
	});

	test('rejects success when concurrent cleanup removes the acquired membership', async () => {
		await db
			.prepare(
				`CREATE TRIGGER delete_lock_after_insert
				AFTER INSERT ON mp_membership
				WHEN NEW.userId = '${USER_ID}'
				BEGIN
					DELETE FROM mp_membership WHERE userId = NEW.userId AND roomCode = NEW.roomCode;
				END`,
			)
			.run();

		const response = await POST({
			request: makeAcquireRequest('MP-RACE01'),
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'ALREADY_IN_ROOM' });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toBeNull();
	});

	test('atomic lock acquisition loses to a ranked session created after stale repair', async () => {
		await db
			.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
			.bind(USER_ID, 'MP-OLD01', Math.trunc((Date.now() - 32_000) / 1000))
			.run();
		await installRankedAfterStaleDelete();
		const goneNamespace = {
			idFromName: () => ({}) as DurableObjectId,
			get: () => ({
				fetch: async () => new Response(null, { status: 404 }),
			}),
		} as unknown as DurableObjectNamespace;

		const response = await POST({
			request: makeAcquireRequest('MP-NEW02'),
			locals: makeLocals(goneNamespace) as any,
		} as any);

		expect(response.status).toBe(409);
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toBeNull();
		expect(
			await db
				.prepare('SELECT id FROM ranked_session WHERE activeUserId = ?')
				.bind(USER_ID)
				.first(),
		).toEqual({ id: 'lock-race-ranked' });
	});
});
