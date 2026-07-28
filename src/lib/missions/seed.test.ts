/**
 * Miniflare integration tests for `seedStreakFromOldMission`.
 *
 * Covers every branch of the seeding function against real workerd SQLite:
 *  1. Streak row already exists → no-op (early return).
 *  2. No old `mission` row for daily-login → no-op.
 *  3. Old daily-login completedDate exists but is not today → no insert.
 *  4. Old daily-login completedDate is today → seeds a login_streak row
 *     with currentStreak=1, longestStreak=1, lastClaimPeriodKey=today.
 *
 * Pattern: see `claim.test.ts` / `progress-integration.test.ts` for the
 * Miniflare + drizzle migration bootstrap this follows.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { D1Database } from '@cloudflare/workers-types';
import { seedStreakFromOldMission } from './seed';
import { getDailyPeriodKey } from './periods';

let mf: Miniflare | null = null;
let db: D1Database | null = null;

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
	.filter((f) => f.endsWith('.sql'))
	.sort();

async function applyMigrations(d1: D1Database): Promise<void> {
	for (const file of MIGRATION_FILES) {
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const prepared = statements.map((stmt) => d1.prepare(stmt));
		await d1.batch(prepared);
	}
}

async function insertUser(d1: D1Database, id: string): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance, heldChips) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, `Test ${id}`, `${id}@test.local`, 0, 1000, 1000, 1000, 0)
		.run();
}

async function insertOldDailyLoginMission(
	d1: D1Database,
	userId: string,
	completedDateSeconds: number | null,
): Promise<void> {
	await d1
		.prepare(`INSERT INTO mission (missionId, userId, completedDate) VALUES ('daily-login', ?, ?)`)
		.bind(userId, completedDateSeconds)
		.run();
}

async function seedStreakRow(
	d1: D1Database,
	userId: string,
	currentStreak: number,
	longestStreak: number,
	lastClaimPeriodKey: string,
): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey) VALUES (?, ?, ?, ?)',
		)
		.bind(userId, currentStreak, longestStreak, lastClaimPeriodKey)
		.run();
}

async function getStreakRow(
	d1: D1Database,
	userId: string,
): Promise<{
	currentStreak: number;
	longestStreak: number;
	lastClaimPeriodKey: string;
} | null> {
	return d1
		.prepare(
			'SELECT currentStreak, longestStreak, lastClaimPeriodKey FROM login_streak WHERE userId = ?',
		)
		.bind(userId)
		.first<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string }>();
}

describe('seedStreakFromOldMission (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'mission-seed-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('is a no-op when a login_streak row already exists for the user', async () => {
		const userId = 'seed-existing';
		await insertUser(db!, userId);
		// Pre-existing streak row — seeding must NOT overwrite it.
		await seedStreakRow(db!, userId, 7, 9, '2020-01-01');
		// Also seed an old daily-login mission that would otherwise trigger
		// an insert; the existing-streak guard must short-circuit first.
		const todaySeconds = Math.trunc(Date.now() / 1000);
		await insertOldDailyLoginMission(db!, userId, todaySeconds);

		await seedStreakFromOldMission(db!, userId);

		const row = await getStreakRow(db!, userId);
		expect(row).not.toBeNull();
		// Untouched.
		expect(row!.currentStreak).toBe(7);
		expect(row!.longestStreak).toBe(9);
		expect(row!.lastClaimPeriodKey).toBe('2020-01-01');
	});

	test('is a no-op when no old daily-login mission row exists', async () => {
		const userId = 'seed-no-old';
		await insertUser(db!, userId);

		await seedStreakFromOldMission(db!, userId);

		const row = await getStreakRow(db!, userId);
		expect(row).toBeNull();
	});

	test('is a no-op when the old daily-login row has a null completedDate', async () => {
		const userId = 'seed-null-date';
		await insertUser(db!, userId);
		await insertOldDailyLoginMission(db!, userId, null);

		await seedStreakFromOldMission(db!, userId);

		const row = await getStreakRow(db!, userId);
		expect(row).toBeNull();
	});

	test('is a no-op when the old daily-login was completed on a different day', async () => {
		const userId = 'seed-different-day';
		await insertUser(db!, userId);
		// Three days ago.
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 3);
		const dSeconds = Math.trunc(d.getTime() / 1000);
		await insertOldDailyLoginMission(db!, userId, dSeconds);

		await seedStreakFromOldMission(db!, userId);

		const row = await getStreakRow(db!, userId);
		expect(row).toBeNull();
	});

	test('seeds a streak row at 1/1/today when the old daily-login was completed today', async () => {
		const userId = 'seed-today';
		await insertUser(db!, userId);
		const today = getDailyPeriodKey();
		// Use a Date exactly at today's UTC midnight so completedDay === today
		// regardless of the current time-of-day.
		const todayMidnightSeconds = Math.trunc(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) /
				1000,
		);
		await insertOldDailyLoginMission(db!, userId, todayMidnightSeconds);

		await seedStreakFromOldMission(db!, userId);

		const row = await getStreakRow(db!, userId);
		expect(row).not.toBeNull();
		expect(row!.currentStreak).toBe(1);
		expect(row!.longestStreak).toBe(1);
		expect(row!.lastClaimPeriodKey).toBe(today);
	});

	test('is idempotent — a second call after the seed does not duplicate or overwrite the row', async () => {
		const userId = 'seed-idem';
		await insertUser(db!, userId);
		const todayMidnightSeconds = Math.trunc(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) /
				1000,
		);
		await insertOldDailyLoginMission(db!, userId, todayMidnightSeconds);

		await seedStreakFromOldMission(db!, userId);
		await seedStreakFromOldMission(db!, userId);

		const row = await getStreakRow(db!, userId);
		expect(row).not.toBeNull();
		expect(row!.currentStreak).toBe(1);
		expect(row!.longestStreak).toBe(1);
	});
});
