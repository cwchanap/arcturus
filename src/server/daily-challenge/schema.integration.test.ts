import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import {
	createDailyChallengeTestD1,
	insertDailyChallenge,
	insertDailyChallengeAttempt,
	insertDailyChallengeResult,
	insertDailyChallengeTestUser,
} from './test-d1';

let mf: Miniflare;
let db: D1Database;

beforeEach(async () => {
	({ mf, db } = await createDailyChallengeTestD1());
});

afterEach(async () => {
	await mf.dispose();
});

async function indexNames(tableName: string): Promise<string[]> {
	const rows = await db.prepare(`PRAGMA index_list('${tableName}')`).all<{ name: string }>();
	return rows.results.map((row) => row.name).sort();
}

async function indexColumns(indexName: string): Promise<string[]> {
	const rows = await db.prepare(`PRAGMA index_info('${indexName}')`).all<{ name: string }>();
	return rows.results.map((row) => row.name);
}

async function primaryKeyColumns(tableName: string): Promise<string[]> {
	const rows = await db.prepare(`PRAGMA table_info('${tableName}')`).all<{
		name: string;
		pk: number;
	}>();
	return rows.results
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => column.name);
}

describe('daily challenge persistence schema', () => {
	test('creates all daily challenge persistence tables', async () => {
		const rows = await db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('daily_challenge', 'daily_challenge_attempt', 'daily_challenge_result')",
			)
			.all<{ name: string }>();

		expect(rows.results.map((row) => row.name).sort()).toEqual([
			'daily_challenge',
			'daily_challenge_attempt',
			'daily_challenge_result',
		]);
	});

	test('enforces unique (challengeKind, periodKey) on daily_challenge', async () => {
		await insertDailyChallenge(db, {
			id: 'c1',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-02',
		});

		await expect(
			insertDailyChallenge(db, {
				id: 'c2',
				challengeKind: 'blackjack-daily',
				periodKey: '2026-08-02',
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);

		// Distinct kind or period may coexist.
		await insertDailyChallenge(db, {
			id: 'c3',
			challengeKind: 'baccarat-daily',
			periodKey: '2026-08-02',
		});
		await insertDailyChallenge(db, {
			id: 'c4',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-03',
		});
	});

	test('enforces unique (challengeId, userId) on daily_challenge_attempt', async () => {
		await insertDailyChallengeTestUser(db, { id: 'schema-user' });
		await insertDailyChallenge(db, {
			id: 'c1',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-02',
		});

		await insertDailyChallengeAttempt(db, {
			id: 'a1',
			challengeId: 'c1',
			userId: 'schema-user',
			startRequestId: 'request-00000001',
		});

		await expect(
			insertDailyChallengeAttempt(db, {
				id: 'a2',
				challengeId: 'c1',
				userId: 'schema-user',
				startRequestId: 'request-00000002',
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	test('enforces global unique (userId, startRequestId) on daily_challenge_attempt', async () => {
		await insertDailyChallengeTestUser(db, { id: 'schema-user' });
		await insertDailyChallenge(db, {
			id: 'c1',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-02',
		});
		await insertDailyChallenge(db, {
			id: 'c2',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-03',
		});

		await insertDailyChallengeAttempt(db, {
			id: 'a1',
			challengeId: 'c1',
			userId: 'schema-user',
			startRequestId: 'shared-request',
		});

		// Same user, same startRequestId across a distinct challenge.
		await expect(
			insertDailyChallengeAttempt(db, {
				id: 'a2',
				challengeId: 'c2',
				userId: 'schema-user',
				startRequestId: 'shared-request',
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	test('uses (challengeId, userId) as daily_challenge_result primary key', async () => {
		expect(await primaryKeyColumns('daily_challenge_result')).toEqual(['challengeId', 'userId']);
	});

	test('enforces unique attemptId on daily_challenge_result without an FK to attempt', async () => {
		// No attempt row exists; the result references attemptId as opaque correlation.
		await insertDailyChallengeTestUser(db, { id: 'schema-user' });
		await insertDailyChallenge(db, {
			id: 'c1',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-02',
		});

		await insertDailyChallengeResult(db, {
			attemptId: 'orphan-attempt-1',
			challengeId: 'c1',
			userId: 'schema-user',
			endingBankroll: 900,
		});

		// Same (challengeId, userId) PK collision via a second attemptId.
		await expect(
			insertDailyChallengeResult(db, {
				attemptId: 'orphan-attempt-2',
				challengeId: 'c1',
				userId: 'schema-user',
				endingBankroll: 800,
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);

		// Duplicate attemptId against a distinct (challengeId, userId) row.
		await insertDailyChallengeTestUser(db, { id: 'other-user' });
		await insertDailyChallenge(db, {
			id: 'c2',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-03',
		});
		await expect(
			insertDailyChallengeResult(db, {
				attemptId: 'orphan-attempt-1',
				challengeId: 'c2',
				userId: 'other-user',
				endingBankroll: 700,
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	test('challenge and result rows survive terminal attempt deletion', async () => {
		await insertDailyChallengeTestUser(db, { id: 'schema-user' });
		await insertDailyChallenge(db, {
			id: 'c1',
			challengeKind: 'blackjack-daily',
			periodKey: '2026-08-02',
		});

		await insertDailyChallengeAttempt(db, {
			id: 'a1',
			challengeId: 'c1',
			userId: 'schema-user',
			startRequestId: 'request-00000001',
			status: 'completed',
			settledAt: Math.trunc(Date.now() / 1000),
		});
		await insertDailyChallengeResult(db, {
			attemptId: 'a1',
			challengeId: 'c1',
			userId: 'schema-user',
			endingBankroll: 1500,
		});

		// Reap the terminal attempt row (90-day retention policy).
		await db.prepare(`DELETE FROM daily_challenge_attempt WHERE id = 'a1'`).run();

		const challengeCount = await db
			.prepare('SELECT COUNT(*) AS count FROM daily_challenge WHERE id = ?')
			.bind('c1')
			.first<{ count: number }>();
		expect(challengeCount?.count).toBe(1);

		const resultCount = await db
			.prepare('SELECT COUNT(*) AS count FROM daily_challenge_result WHERE challengeId = ?')
			.bind('c1')
			.first<{ count: number }>();
		expect(resultCount?.count).toBe(1);

		const attemptCount = await db
			.prepare('SELECT COUNT(*) AS count FROM daily_challenge_attempt WHERE id = ?')
			.bind('a1')
			.first<{ count: number }>();
		expect(attemptCount?.count).toBe(0);
	});

	test('creates daily_challenge_kind_period_idx and daily_challenge_ends_at_idx indexes', async () => {
		const names = await indexNames('daily_challenge');
		expect(names).toContain('daily_challenge_kind_period_idx');
		expect(names).toContain('daily_challenge_ends_at_idx');
	});

	test('creates status/expiry and leaderboard indexes on attempt and result', async () => {
		const attemptIndexes = await indexNames('daily_challenge_attempt');
		expect(attemptIndexes).toContain('daily_challenge_attempt_status_expiry_idx');
		expect(await indexColumns('daily_challenge_attempt_status_expiry_idx')).toEqual([
			'status',
			'expiresAt',
		]);

		const resultIndexes = await indexNames('daily_challenge_result');
		expect(resultIndexes).toContain('daily_challenge_result_leaderboard_idx');
		expect(await indexColumns('daily_challenge_result_leaderboard_idx')).toEqual([
			'challengeId',
			'eligible',
			'endingBankroll',
			'roundsCompleted',
			'settledAt',
			'userId',
		]);
		expect(resultIndexes).toContain('daily_challenge_result_user_settled_idx');
		expect(await indexColumns('daily_challenge_result_user_settled_idx')).toEqual([
			'userId',
			'settledAt',
		]);
	});
});
