/**
 * Miniflare integration test: proves `applyMissionProgress` against real D1
 * (workerd SQLite), not a mock simulation.
 *
 * Verifies the UPSERT + ON CONFLICT ... DO UPDATE semantics:
 *  - Progress increments for matching game events
 *  - Progress clamps at def.target
 *  - completedAt is set exactly once (first time target reached)
 *  - Non-matching events do not increment a mission
 *  - gamesTried metadata deduplication works across calls
 *  - Null outcome short-circuits the whole function (no rows written)
 *
 * Pattern: see src/lib/roulette/spin-cascade.integration.test.ts for the
 * Miniflare + drizzle migration bootstrap.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { applyMissionProgress } from './progress';
import type { MissionGameEvent } from './types';
import type { D1Database } from '@cloudflare/workers-types';

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

interface ProgressRow {
	missionDefId: string;
	periodKey: string;
	progress: number;
	metadataJson: string | null;
	completedAt: number | null;
	claimedAt: number | null;
}

async function getProgressRow(
	d1: D1Database,
	userId: string,
	missionDefId: string,
): Promise<ProgressRow | null> {
	return d1
		.prepare(
			'SELECT missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt FROM mission_progress WHERE userId = ? AND missionDefId = ?',
		)
		.bind(userId, missionDefId)
		.first<ProgressRow>();
}

async function countProgressRows(d1: D1Database, userId: string): Promise<number> {
	const row = await d1
		.prepare('SELECT COUNT(*) AS n FROM mission_progress WHERE userId = ?')
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function makeEvent(overrides: Partial<MissionGameEvent>): MissionGameEvent {
	return {
		gameType: 'blackjack',
		outcome: 'win',
		handCount: 1,
		winsIncrement: 1,
		lossesIncrement: 0,
		delta: 100,
		...overrides,
	};
}

describe('applyMissionProgress (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'mission-progress-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('increments progress for a matching game event', async () => {
		const userId = 'user-incr';
		await insertUser(db!, userId);

		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 1 }));

		const row = await getProgressRow(db!, userId, 'daily-blackjack-5');
		expect(row).not.toBeNull();
		expect(row!.progress).toBe(1);
		expect(row!.completedAt).toBeNull();
	});

	test('clamps progress at target and sets completedAt', async () => {
		const userId = 'user-clamp';
		await insertUser(db!, userId);

		// Target for daily-blackjack-5 is 5; send handCount=10 in one event.
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 10 }));

		const row = await getProgressRow(db!, userId, 'daily-blackjack-5');
		expect(row).not.toBeNull();
		expect(row!.progress).toBe(5);
		expect(row!.completedAt).not.toBeNull();
	});

	test('completedAt is set exactly once across multiple over-counts', async () => {
		const userId = 'user-once';
		await insertUser(db!, userId);

		// First call reaches target (5).
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 5 }));
		const firstRow = await getProgressRow(db!, userId, 'daily-blackjack-5');
		expect(firstRow!.progress).toBe(5);
		expect(firstRow!.completedAt).not.toBeNull();

		// Seed a distinct completedAt that differs from the current second.
		// Without this, both calls share the same nowSeconds, so an
		// overwrite would be undetectable (the new value equals the old).
		const seededCompletedAt = (firstRow!.completedAt ?? 0) - 100;
		await db!
			.prepare('UPDATE mission_progress SET completedAt = ? WHERE userId = ? AND missionDefId = ?')
			.bind(seededCompletedAt, userId, 'daily-blackjack-5')
			.run();

		// Second call would exceed target — the CASE in the UPSERT must
		// preserve the seeded completedAt rather than overwriting it.
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 3 }));
		const secondRow = await getProgressRow(db!, userId, 'daily-blackjack-5');
		expect(secondRow!.progress).toBe(5);
		expect(secondRow!.completedAt).toBe(seededCompletedAt);
	});

	test('does NOT increment a mission whose metric does not match the event', async () => {
		const userId = 'user-nomatch';
		await insertUser(db!, userId);

		// daily-blackjack-5 requires gameType=blackjack; a craps event must
		// not create a progress row for it.
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'craps', handCount: 1 }));

		const row = await getProgressRow(db!, userId, 'daily-blackjack-5');
		expect(row).toBeNull();
	});

	test('gamesTried deduplicates across repeated events for the same gameType', async () => {
		const userId = 'user-dedup';
		await insertUser(db!, userId);

		// weekly-games-3 uses gamesTried (target 3). First blackjack event
		// should record progress=1 with metadata ['blackjack'].
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 1 }));
		const afterFirst = await getProgressRow(db!, userId, 'weekly-games-3');
		expect(afterFirst!.progress).toBe(1);
		expect(JSON.parse(afterFirst!.metadataJson!)).toEqual(['blackjack']);

		// Repeated blackjack event must NOT increment (dedup).
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 1 }));
		const afterSecond = await getProgressRow(db!, userId, 'weekly-games-3');
		expect(afterSecond!.progress).toBe(1);
		expect(JSON.parse(afterSecond!.metadataJson!)).toEqual(['blackjack']);

		// A different gameType increments again.
		await applyMissionProgress(db!, userId, makeEvent({ gameType: 'craps', handCount: 1 }));
		const afterThird = await getProgressRow(db!, userId, 'weekly-games-3');
		expect(afterThird!.progress).toBe(2);
		expect(JSON.parse(afterThird!.metadataJson!)).toEqual(['blackjack', 'craps']);
	});

	test('gamesTried preserves both contributions when distinct game types arrive concurrently', async () => {
		const userId = 'user-concurrent';
		await insertUser(db!, userId);

		// Two concurrent requests for different game types. With the old
		// absolute-write approach, both read the same stale state and the
		// second overwrote the first — losing one contribution. The per-game
		// dedup table makes progress = COUNT(*) from mission_game_tried, so
		// both rows contribute and progress ends at 2.
		await Promise.all([
			applyMissionProgress(db!, userId, makeEvent({ gameType: 'blackjack', handCount: 1 })),
			applyMissionProgress(db!, userId, makeEvent({ gameType: 'craps', handCount: 1 })),
		]);

		const row = await getProgressRow(db!, userId, 'weekly-games-3');
		expect(row).not.toBeNull();
		expect(row!.progress).toBe(2);

		// Both game types should be recorded in the dedup table.
		const dedupRows = await db!
			.prepare(
				'SELECT gameType FROM mission_game_tried WHERE userId = ? AND missionDefId = ? ORDER BY gameType',
			)
			.bind(userId, 'weekly-games-3')
			.all<{ gameType: string }>();
		expect(dedupRows.results.map((r) => r.gameType)).toEqual(['blackjack', 'craps']);
	});

	test('skips entirely (writes nothing) when outcome is null', async () => {
		const userId = 'user-null';
		await insertUser(db!, userId);

		await applyMissionProgress(db!, userId, makeEvent({ outcome: null, handCount: 5 }));

		const count = await countProgressRows(db!, userId);
		expect(count).toBe(0);
	});

	test('skips entirely (writes nothing) when outcome is undefined', async () => {
		const userId = 'user-undef';
		await insertUser(db!, userId);

		await applyMissionProgress(db!, userId, makeEvent({ outcome: undefined, handCount: 5 }));

		const count = await countProgressRows(db!, userId);
		expect(count).toBe(0);
	});
});
