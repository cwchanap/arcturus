import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { createRankedTestD1, insertRankedTestUser } from './test-d1';

let mf: Miniflare;
let db: D1Database;

beforeEach(async () => {
	({ mf, db } = await createRankedTestD1());
});

afterEach(async () => {
	await mf.dispose();
});

async function insertSession(
	db: D1Database,
	values: { id: string; activeUserId: string | null; startRequestId: string },
) {
	const now = Math.trunc(Date.now() / 1000);
	return db
		.prepare(
			`INSERT INTO ranked_session (
				id, userId, startRequestId, startPayloadHash, activeUserId,
				gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
				actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
				status, expiresAt, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			values.id,
			'schema-user',
			values.startRequestId,
			'start-hash',
			values.activeUserId,
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
			values.activeUserId === null ? 'settled' : 'active',
			now + 900,
			now,
			now,
		)
		.run();
}

async function countRows(db: D1Database, table: 'ranked_session'): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
	return row?.count ?? 0;
}

describe('ranked persistence schema', () => {
	test('creates all ranked persistence tables', async () => {
		const rows = await db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ranked_session', 'ranked_result', 'ranked_game_stats', 'ranked_reward_grant', 'ranked_rate_limit')",
			)
			.all<{ name: string }>();

		expect(rows.results.map((row) => row.name).sort()).toEqual([
			'ranked_game_stats',
			'ranked_rate_limit',
			'ranked_result',
			'ranked_reward_grant',
			'ranked_session',
		]);
	});

	test('enforces one ranked start request per user', async () => {
		await insertRankedTestUser(db, { id: 'schema-user' });
		await insertSession(db, {
			id: 's1',
			activeUserId: 'schema-user',
			startRequestId: 'request-00000001',
		});

		await expect(
			insertSession(db, {
				id: 's2',
				activeUserId: null,
				startRequestId: 'request-00000001',
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	test('allows sequential terminal sessions but only one active session per user', async () => {
		await insertRankedTestUser(db, { id: 'schema-user' });
		await insertSession(db, {
			id: 's1',
			activeUserId: 'schema-user',
			startRequestId: 'request-00000001',
		});
		await expect(
			insertSession(db, {
				id: 's2',
				activeUserId: 'schema-user',
				startRequestId: 'request-00000002',
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);
		await db
			.prepare('UPDATE ranked_session SET activeUserId = NULL, status = ? WHERE id = ?')
			.bind('settled', 's1')
			.run();
		await insertSession(db, {
			id: 's2',
			activeUserId: 'schema-user',
			startRequestId: 'request-00000002',
		});
		await db
			.prepare('UPDATE ranked_session SET activeUserId = NULL, status = ? WHERE id = ?')
			.bind('settled', 's2')
			.run();
		expect(await countRows(db, 'ranked_session')).toBe(2);
	});

	test('uses user, operation, and window start as the rate-limit primary key', async () => {
		const columns = await db.prepare('PRAGMA table_info(ranked_rate_limit)').all<{
			name: string;
			pk: number;
		}>();

		expect(
			columns.results
				.filter((column) => column.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((column) => column.name),
		).toEqual(['userId', 'operation', 'windowStart']);
	});
});
