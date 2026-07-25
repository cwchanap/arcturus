import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { POST } from '../../pages/api/mp/rooms/index';
import { createRankedTestD1, insertRankedTestUser } from '../ranked/test-d1';

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

function makeLocals() {
	return {
		user: { id: USER_ID },
		runtime: { env: { DB: db } },
	};
}

async function seedActiveRankedSession(): Promise<void> {
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
			'rooms-ranked-session',
			USER_ID,
			'rooms-ranked-request',
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
		)
		.run();
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
});
