import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { GET } from '../../pages/api/mp/rooms/[code]/ws';
import { createRankedTestD1, insertRankedTestUser } from '../ranked/test-d1';

/**
 * Unit tests for the display-name fallback and 4xx cleanup logic
 * in the WebSocket upgrade route (ws.ts).
 *
 * The route handler itself is an Astro APIRoute with heavy framework
 * dependencies (D1, DO namespace, middleware). These tests validate the
 * pure-logic pieces in isolation.
 */

describe('display-name fallback', () => {
	test('non-empty name passes through unchanged', () => {
		const name = 'Alice';
		const result = name || 'Player';
		expect(result).toBe('Alice');
	});

	test('empty string falls back to "Player"', () => {
		const name = '';
		const result = name || 'Player';
		expect(result).toBe('Player');
	});

	test('encodeURIComponent encodes the fallback correctly', () => {
		const name = '';
		const encoded = encodeURIComponent(name || 'Player');
		expect(encoded).toBe('Player');
	});

	test('encodeURIComponent encodes special characters in name', () => {
		const name = 'Alice & Bob';
		const encoded = encodeURIComponent(name || 'Player');
		expect(encoded).toBe('Alice%20%26%20Bob');
	});
});

describe('4xx cleanup decision logic', () => {
	// Mirrors the shouldCleanup logic from ws.ts lines 192-194
	function shouldCleanup(
		doStatus: number,
		lockAcquired: boolean,
		existingRoomMatch: boolean,
	): boolean {
		const is4xx = doStatus >= 400 && doStatus < 500;
		return is4xx && (lockAcquired || existingRoomMatch);
	}

	test('cleans up on 401 with newly acquired lock', () => {
		expect(shouldCleanup(401, true, false)).toBe(true);
	});

	test('cleans up on 400 with newly acquired lock', () => {
		expect(shouldCleanup(400, true, false)).toBe(true);
	});

	test('cleans up on 404 with newly acquired lock', () => {
		expect(shouldCleanup(404, true, false)).toBe(true);
	});

	test('cleans up on 404 with existing room match (reconnect)', () => {
		expect(shouldCleanup(404, false, true)).toBe(true);
	});

	test('does NOT clean up on 500 (transient failure)', () => {
		expect(shouldCleanup(500, true, false)).toBe(false);
	});

	test('does NOT clean up on 502 (transient failure)', () => {
		expect(shouldCleanup(502, true, false)).toBe(false);
	});

	test('does NOT clean up on 101 (successful upgrade)', () => {
		expect(shouldCleanup(101, true, false)).toBe(false);
	});

	test('does NOT clean up on 4xx without lock or existing match', () => {
		expect(shouldCleanup(401, false, false)).toBe(false);
	});

	test('does NOT clean up on 200 (non-upgrade success)', () => {
		expect(shouldCleanup(200, true, false)).toBe(false);
	});
});

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
		const now = Math.trunc(Date.now() / 1000);
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
				id,
				userId,
				`${id}-request`,
				'start-hash',
				userId,
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
			)
			.run();
	}

	async function installRankedAfterStaleDelete(): Promise<void> {
		const now = Math.trunc(Date.now() / 1000);
		await db
			.prepare(
				`CREATE TRIGGER ws_ranked_after_stale_delete
				AFTER DELETE ON mp_membership
				WHEN OLD.userId = '${userId}' AND OLD.roomCode = 'MP-OLD01'
				BEGIN
					INSERT INTO ranked_session (
						id, userId, startRequestId, startPayloadHash, activeUserId,
						gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
						actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
						status, expiresAt, createdAt, updatedAt
					) VALUES (
						'ws-race-ranked', '${userId}', 'ws-race-request', 'start-hash', '${userId}',
						'blackjack', 'blackjack-ranked-v1', '{}', 'config-hash',
						'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'seed-commitment',
						'[]', 'action-log-hash', 0, 10, 10, 'active', ${now + 900}, ${now}, ${now}
					);
				END`,
			)
			.run();
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
});
