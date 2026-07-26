import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { GET } from '../../pages/api/mp/rooms/[code]/ws';
import {
	createRankedTestD1,
	insertRankedSession,
	insertRankedTestUser,
	installRankedAfterStaleDelete as installRankedAfterStaleDeleteHelper,
} from '../ranked/test-d1';

/**
 * Integration tests for the WebSocket upgrade route (ws.ts).
 *
 * The route handler is an Astro APIRoute with framework dependencies
 * (D1, DO namespace, middleware). These tests exercise the real route
 * handler against a Miniflare-backed D1 to verify ranked exclusion,
 * escrow handling, origin validation, and DO upgrade failure cleanup.
 *
 * The display-name fallback (`name || 'Player'`) and the 4xx cleanup
 * decision predicate are intentionally NOT unit-tested here in
 * isolation: duplicating the production expression into a local helper
 * and asserting on the copy is tautological — it tests the test's own
 * logic, not the route's. The 4xx cleanup behavior is instead covered
 * by the `upgrade DO failure handling` describe below, which drives the
 * real route with DO stubs returning 4xx/5xx and asserts on the
 * resulting membership/escrow state.
 */

describe('WebSocket join membership policy', () => {
	const userId = 'ws-route-user';
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
			db.prepare('DROP TRIGGER IF EXISTS ws_ranked_after_stale_delete'),
			db.prepare('DELETE FROM ranked_session'),
			db.prepare('DELETE FROM mp_membership'),
			db.prepare('DELETE FROM user'),
		]);
		await insertRankedTestUser(db, { id: userId, chipBalance: 500 });
	});

	function makeRequest(): Request {
		return new Request('http://test.local/api/mp/rooms/MP-JOIN01/ws', {
			headers: { Upgrade: 'websocket' },
		});
	}

	function makeLocals(namespace?: DurableObjectNamespace) {
		return {
			user: { id: userId, name: 'WebSocket User' },
			runtime: { env: { DB: db, arcturus: namespace } },
		};
	}

	async function callJoin(namespace?: DurableObjectNamespace): Promise<Response> {
		const request = makeRequest();
		return GET({
			params: { code: 'MP-JOIN01' },
			request,
			locals: makeLocals(namespace) as any,
			url: new URL(request.url),
		} as any);
	}

	async function seedActiveRankedSession(id = 'ws-active-ranked'): Promise<void> {
		await insertRankedSession(db, {
			id,
			userId,
			startRequestId: `${id}-request`,
			activeUserId: userId,
		});
	}

	async function installRankedAfterStaleDelete(): Promise<void> {
		await installRankedAfterStaleDeleteHelper(db, {
			userId,
			roomCode: 'MP-OLD01',
			sessionId: 'ws-race-ranked',
			startRequestId: 'ws-race-request',
			triggerName: 'ws_ranked_after_stale_delete',
		});
	}

	function goneThenUpgradeNamespace(): DurableObjectNamespace {
		return {
			idFromName: () => ({}) as DurableObjectId,
			get: () => ({
				fetch: async (input: RequestInfo | URL) => {
					if (String(input).endsWith('/metadata')) {
						return new Response(null, { status: 404 });
					}
					return { status: 101 } as Response;
				},
			}),
		} as unknown as DurableObjectNamespace;
	}

	test('rejects a browser join while the user has an active ranked session', async () => {
		await seedActiveRankedSession();

		const response = await callJoin();

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'ALREADY_IN_ROOM' });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(userId).first(),
		).toBeNull();
	});

	test('fails closed when a browser join finds orphaned held chips', async () => {
		await db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(500, userId).run();

		const response = await callJoin();

		expect(response.status).toBe(409);
		expect(
			await db.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?').bind(userId).first(),
		).toEqual({ chipBalance: 500, heldChips: 500 });
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(userId).first(),
		).toBeNull();
	});

	test('atomic join loses to a ranked session created after stale repair', async () => {
		await db
			.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
			.bind(userId, 'MP-OLD01', Math.trunc((Date.now() - 32_000) / 1000))
			.run();
		await installRankedAfterStaleDelete();

		const response = await callJoin(goneThenUpgradeNamespace());

		expect(response.status).toBe(409);
		expect(
			await db.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?').bind(userId).first(),
		).toBeNull();
		expect(
			await db.prepare('SELECT id FROM ranked_session WHERE activeUserId = ?').bind(userId).first(),
		).toEqual({ id: 'ws-race-ranked' });
	});

	describe('upgrade request validation', () => {
		async function callGet({
			code = 'MP-JOIN01',
			headers,
			user = userId,
			namespace,
		}: {
			code?: string;
			headers: Record<string, string>;
			user?: string | null;
			namespace?: DurableObjectNamespace;
		}): Promise<Response> {
			const request = new Request(`http://test.local/api/mp/rooms/${code}/ws`, { headers });
			return GET({
				params: { code },
				request,
				locals:
					user === null
						? ({ runtime: { env: { DB: db, arcturus: namespace } } } as any)
						: ({
								user: { id: user, name: 'WebSocket User' },
								runtime: { env: { DB: db, arcturus: namespace } },
							} as any),
				url: new URL(request.url),
			} as any);
		}

		test('rejects a malformed room code with 400', async () => {
			const response = await callGet({
				code: 'not-a-code',
				headers: { Upgrade: 'websocket' },
			});
			expect(response.status).toBe(400);
		});

		test('rejects an unauthenticated request with 401', async () => {
			const response = await callGet({
				headers: { Upgrade: 'websocket' },
				user: null,
			});
			expect(response.status).toBe(401);
		});

		test('rejects a cross-origin upgrade with 403', async () => {
			const response = await callGet({
				headers: { Upgrade: 'websocket', Origin: 'http://evil.test' },
			});
			expect(response.status).toBe(403);
		});

		test('rejects a malformed Origin header with 403', async () => {
			const response = await callGet({
				headers: { Upgrade: 'websocket', Origin: 'http://[invalid' },
			});
			expect(response.status).toBe(403);
		});

		test('allows same-origin upgrades (Origin matches Host)', async () => {
			const response = await callGet({
				headers: { Upgrade: 'websocket', Origin: 'http://test.local' },
			});
			// Past origin check; rejected deterministically because the arcturus
			// binding is missing (callGet does not pass a namespace).
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: 'DO_UNAVAILABLE' });
		});

		test('rejects a non-websocket request with 426', async () => {
			const response = await callGet({
				headers: { Origin: 'http://test.local' },
			});
			expect(response.status).toBe(426);
		});
	});

	describe('upgrade DO failure handling', () => {
		function upgradeStatusNamespace(status: number): DurableObjectNamespace {
			return {
				idFromName: () => ({}) as DurableObjectId,
				get: () => ({
					fetch: async (input: RequestInfo | URL) => {
						if (String(input).endsWith('/metadata')) {
							return new Response(null, { status: 404 });
						}
						return new Response('rejected', { status });
					},
				}),
			} as unknown as DurableObjectNamespace;
		}

		function upgradeThrowNamespace(): DurableObjectNamespace {
			return {
				idFromName: () => ({}) as DurableObjectId,
				get: () => ({
					fetch: async (input: RequestInfo | URL) => {
						if (String(input).endsWith('/metadata')) {
							return new Response(null, { status: 404 });
						}
						throw new Error('DO upgrade exploded');
					},
				}),
			} as unknown as DurableObjectNamespace;
		}

		async function callUpgrade(namespace?: DurableObjectNamespace): Promise<Response> {
			const request = new Request('http://test.local/api/mp/rooms/MP-JOIN01/ws', {
				headers: { Upgrade: 'websocket', Origin: 'http://test.local' },
			});
			return GET({
				params: { code: 'MP-JOIN01' },
				request,
				locals: {
					user: { id: userId, name: 'WebSocket User' },
					runtime: { env: { DB: db, arcturus: namespace } },
				} as any,
				url: new URL(request.url),
			} as any);
		}

		async function membershipRow(): Promise<{ roomCode: string } | null> {
			return (await db
				.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?')
				.bind(userId)
				.first()) as { roomCode: string } | null;
		}

		async function userBalance(): Promise<{ chipBalance: number; heldChips: number }> {
			return (await db
				.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?')
				.bind(userId)
				.first()) as { chipBalance: number; heldChips: number };
		}

		test('returns 503 DO_UNAVAILABLE and releases the acquired lock when the binding is missing', async () => {
			const response = await callUpgrade(undefined);

			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: 'DO_UNAVAILABLE' });
			expect(await membershipRow()).toBeNull();
		});

		test('returns 502 DO_ERROR and releases the acquired lock when the DO fetch throws', async () => {
			const response = await callUpgrade(upgradeThrowNamespace());

			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({ error: 'DO_ERROR' });
			expect(await membershipRow()).toBeNull();
		});

		test('cleans up the membership lock when the DO rejects the upgrade with a 4xx', async () => {
			const response = await callUpgrade(upgradeStatusNamespace(404));

			expect(response.status).toBe(404);
			expect(await membershipRow()).toBeNull();
		});

		test('releases escrowed chips and deletes the membership on a 4xx for an existing same-room member', async () => {
			const joinedAt = Math.trunc(Date.now() / 1000);
			await db.batch([
				db
					.prepare('INSERT INTO mp_membership (userId, roomCode, joinedAt) VALUES (?, ?, ?)')
					.bind(userId, 'MP-JOIN01', joinedAt),
				db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(500, userId),
			]);

			const response = await callUpgrade(upgradeStatusNamespace(404));

			expect(response.status).toBe(404);
			expect(await membershipRow()).toBeNull();
			expect(await userBalance()).toEqual({ chipBalance: 1000, heldChips: 0 });
		});

		test('does NOT clean up the membership lock on a 5xx transient failure', async () => {
			const response = await callUpgrade(upgradeStatusNamespace(500));

			expect(response.status).toBe(500);
			// Lock acquired during this request must remain so the user cannot
			// double-spend via another room while the DO may still hold escrow.
			const row = await membershipRow();
			expect(row).not.toBeNull();
			expect(row?.roomCode).toBe('MP-JOIN01');
		});

		test('returns the DO upgrade response (101) on a successful upgrade and keeps the lock', async () => {
			const namespace: DurableObjectNamespace = {
				idFromName: () => ({}) as DurableObjectId,
				get: () => ({
					fetch: async (input: RequestInfo | URL) => {
						if (String(input).endsWith('/metadata')) {
							return new Response(null, { status: 404 });
						}
						return { status: 101 } as Response;
					},
				}),
			} as unknown as DurableObjectNamespace;

			const response = await callUpgrade(namespace);

			expect(response.status).toBe(101);
			const row = await membershipRow();
			expect(row).not.toBeNull();
			expect(row?.roomCode).toBe('MP-JOIN01');
		});
	});
});
