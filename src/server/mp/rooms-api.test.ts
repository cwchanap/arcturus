import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { POST } from '../../pages/api/mp/rooms/index';
import {
	createRankedTestD1,
	insertRankedSession,
	insertRankedTestUser,
	installRankedAfterStaleDelete as installRankedAfterStaleDeleteHelper,
} from '../ranked/test-d1';

const USER_ID = 'rooms-api-user';
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
		db.prepare('DROP TRIGGER IF EXISTS rooms_ranked_after_stale_delete'),
		db.prepare('DELETE FROM ranked_session'),
		db.prepare('DELETE FROM mp_membership'),
		db.prepare('DELETE FROM user'),
	]);
	await insertRankedTestUser(db, { id: USER_ID, chipBalance: 500 });
});

function makeRequest(): Request {
	return new Request('http://test.local/api/mp/rooms', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ maxSeats: 2, smallBlind: 10, bigBlind: 20 }),
	});
}

function makeLocals(namespace?: DurableObjectNamespace) {
	return {
		user: { id: USER_ID },
		runtime: { env: { DB: db, arcturus: namespace } },
	};
}

async function seedActiveRankedSession(): Promise<void> {
	await insertRankedSession(db, {
		id: 'rooms-ranked-session',
		userId: USER_ID,
		startRequestId: 'rooms-ranked-request',
		activeUserId: USER_ID,
	});
}

async function installRankedAfterStaleDelete(): Promise<void> {
	await installRankedAfterStaleDeleteHelper(db, {
		userId: USER_ID,
		roomCode: 'MP-OLD01',
		sessionId: 'rooms-race-ranked',
		startRequestId: 'rooms-race-request',
		triggerName: 'rooms_ranked_after_stale_delete',
	});
}

function goneThenInitNamespace(): DurableObjectNamespace {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/metadata')) {
					return new Response(null, { status: 404 });
				}
				return new Response(null, { status: 200 });
			},
		}),
	} as unknown as DurableObjectNamespace;
}

function initSuccessNamespace(): DurableObjectNamespace {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/metadata')) {
					return new Response(null, { status: 404 });
				}
				return new Response(null, { status: 200 });
			},
		}),
	} as unknown as DurableObjectNamespace;
}

function initStatusNamespace(status: number, body: string = ''): DurableObjectNamespace {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/metadata')) {
					return new Response(null, { status: 404 });
				}
				return new Response(body, { status });
			},
		}),
	} as unknown as DurableObjectNamespace;
}

function initThrowNamespace(): DurableObjectNamespace {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/metadata')) {
					return new Response(null, { status: 404 });
				}
				throw new Error('DO fetch exploded');
			},
		}),
	} as unknown as DurableObjectNamespace;
}

function initCollisionThenSuccessNamespace(failures: number): DurableObjectNamespace {
	let initCalls = 0;
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/metadata')) {
					return new Response(null, { status: 404 });
				}
				initCalls += 1;
				if (initCalls <= failures) {
					return new Response(null, { status: 409 });
				}
				return new Response(null, { status: 200 });
			},
		}),
	} as unknown as DurableObjectNamespace;
}

function makeRequestWithBody(body: unknown): Request {
	return new Request('http://test.local/api/mp/rooms', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function membershipRoomCode(): Promise<{ roomCode: string } | null> {
	return (await db
		.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?')
		.bind(USER_ID)
		.first()) as { roomCode: string } | null;
}

describe('mp/rooms create membership policy', () => {
	test('rejects room creation while the user has an active ranked session', async () => {
		await seedActiveRankedSession();

		const response = await POST({
			request: makeRequest(),
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'ALREADY_IN_ROOM' });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toBeNull();
	});

	test('does not create a room when held chips have no membership', async () => {
		await db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(500, USER_ID).run();

		const response = await POST({
			request: makeRequest(),
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'ALREADY_IN_ROOM' });
		expect(
			await db
				.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?')
				.bind(USER_ID)
				.first(),
		).toEqual({ chipBalance: 500, heldChips: 500 });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(USER_ID).first(),
		).toBeNull();
	});

	test('atomic room creation loses to a ranked session created after stale repair', async () => {
		await db
			.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
			.bind(USER_ID, 'MP-OLD01', Math.trunc((Date.now() - 32_000) / 1000))
			.run();
		await installRankedAfterStaleDelete();

		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(goneThenInitNamespace()) as any,
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
		).toEqual({ id: 'rooms-race-ranked' });
	});
});

describe('mp/rooms create success and validation paths', () => {
	test('creates a room and records the membership lock on success', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(initSuccessNamespace()) as any,
		} as any);

		expect(response.status).toBe(201);
		const body = (await response.json()) as { code: string };
		expect(body.code).toMatch(/^MP-[A-Z0-9]{6}$/);
		expect(await membershipRoomCode()).toEqual({ roomCode: body.code });
	});

	test('rejects malformed JSON with INVALID_JSON and releases the lock', async () => {
		const request = new Request('http://test.local/api/mp/rooms', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not-json',
		});

		const response = await POST({
			request,
			locals: makeLocals(initSuccessNamespace()) as any,
		} as any);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'INVALID_JSON' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('rejects out-of-range maxSeats with INVALID_CONFIG and releases the lock', async () => {
		const response = await POST({
			request: makeRequestWithBody({ maxSeats: 7, smallBlind: 10, bigBlind: 20 }),
			locals: makeLocals(initSuccessNamespace()) as any,
		} as any);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'INVALID_CONFIG' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('rejects bigBlind below 2x smallBlind with INVALID_CONFIG and releases the lock', async () => {
		const response = await POST({
			request: makeRequestWithBody({ maxSeats: 2, smallBlind: 10, bigBlind: 15 }),
			locals: makeLocals(initSuccessNamespace()) as any,
		} as any);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'INVALID_CONFIG' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('rejects non-integer wagers with INVALID_CONFIG and releases the lock', async () => {
		const response = await POST({
			request: makeRequestWithBody({ maxSeats: 2, smallBlind: 1.5, bigBlind: 4 }),
			locals: makeLocals(initSuccessNamespace()) as any,
		} as any);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'INVALID_CONFIG' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('returns DO_UNAVAILABLE (503) when the arcturus binding is missing and releases the lock', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(undefined) as any,
		} as any);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'DO_UNAVAILABLE' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('returns 502 DO_UNAVAILABLE when the DO fetch throws and releases the lock', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(initThrowNamespace()) as any,
		} as any);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'DO_UNAVAILABLE' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('returns 502 with the DO error body when the DO rejects init with a non-409 status', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(initStatusNamespace(500, '{"error":"DO_INTERNAL"}')) as any,
		} as any);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'DO_INTERNAL' });
		expect(await membershipRoomCode()).toBeNull();
	});

	test('retries with a new code on 409 collision and updates the membership row', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(initCollisionThenSuccessNamespace(1)) as any,
		} as any);

		expect(response.status).toBe(201);
		const body = (await response.json()) as { code: string };
		expect(body.code).toMatch(/^MP-[A-Z0-9]{6}$/);
		expect(await membershipRoomCode()).toEqual({ roomCode: body.code });
	});

	test('returns 500 CODE_GENERATION_FAILED when all retry attempts collide', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: makeLocals(initStatusNamespace(409)) as any,
		} as any);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'CODE_GENERATION_FAILED' });
		expect(await membershipRoomCode()).toBeNull();
	});
});
