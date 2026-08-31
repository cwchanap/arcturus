/**
 * Mock-based unit tests for the DB-touching functions in progress.ts.
 *
 * The pure helpers (computeIncrement, clampProgress, parseMetadata) are
 * covered in `progress.test.ts`. The Miniflare integration tests in
 * `progress-integration.test.ts` prove the UPSERT + ON CONFLICT semantics
 * against real workerd SQLite. This file provides a coverage floor that
 * runs anywhere `bun test` runs — no workerd required — by routing D1
 * calls through the shared mock in `mock-d1.ts`.
 *
 * Covers:
 *  - applyMissionProgress: null/undefined outcome short-circuit, matching
 *    event → batch, non-matching event → empty batch (no call), gamesTried
 *    → dedup INSERT + UPSERT, existing progress row → increment
 *  - buildProgressUpsertSQL: SQL template + bind params, completedAt clause
 *    when amount >= target, NULL when amount < target
 *  - buildGamesTriedUpsertSQL: SQL template + bind params (10 binds)
 */

import { describe, expect, test } from 'bun:test';
import { applyMissionProgress, buildProgressUpsertSQL, buildGamesTriedUpsertSQL } from './progress';
import { makeMockD1 } from './mock-d1';
import { getDailyPeriodKey, getWeeklyPeriodKey } from './periods';
import { DEFAULT_DAILY_MISSIONS, DEFAULT_WEEKLY_MISSIONS } from './registry';
import type { MissionDefinition, MissionGameEvent } from './types';

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

describe('applyMissionProgress (mocked D1)', () => {
	test('skips entirely (writes nothing) when outcome is null', async () => {
		const mock = makeMockD1();
		await applyMissionProgress(
			mock.binding,
			'user-null',
			makeEvent({ outcome: null, handCount: 5 }),
		);
		// No D1 calls at all — the null-outcome guard fires before any reads.
		expect(mock.calls).toHaveLength(0);
	});

	test('skips entirely (writes nothing) when outcome is undefined', async () => {
		const mock = makeMockD1();
		await applyMissionProgress(
			mock.binding,
			'user-undef',
			makeEvent({ outcome: undefined, handCount: 5 }),
		);
		expect(mock.calls).toHaveLength(0);
	});

	test('issues a batch with a progress UPSERT for a matching blackjack event', async () => {
		const mock = makeMockD1();
		// getOverrides → empty
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		// getProgressRows → empty (no existing progress)
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));
		// batch → success
		mock.onRun('INSERT INTO mission_progress', () => ({ meta: { changes: 1 } }));
		mock.onRun('INSERT OR IGNORE INTO mission_game_tried', () => ({ meta: { changes: 1 } }));

		await applyMissionProgress(
			mock.binding,
			'user-incr',
			makeEvent({ gameType: 'blackjack', handCount: 1 }),
		);

		// The batch should contain at least one INSERT INTO mission_progress
		// for daily-blackjack-5 (handsPlayed, gameType=blackjack).
		const progressInserts = mock.calls.filter((c) =>
			c.sql.startsWith('INSERT INTO mission_progress'),
		);
		expect(progressInserts.length).toBeGreaterThanOrEqual(1);
	});

	test('does NOT issue any batch when no mission matches the event', async () => {
		const mock = makeMockD1();
		const weeklyKey = getWeeklyPeriodKey();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		// Return existing weekly-games-3 progress with metadata that already
		// includes 'craps' — the gamesTried metric will return amount=0,
		// so no statement is pushed for the weekly mission either.
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'weekly-games-3',
					periodKey: weeklyKey,
					progress: 1,
					metadataJson: '["craps"]',
					completedAt: null,
					claimedAt: null,
				},
			],
		}));

		// A craps event with outcome=loss, winsIncrement=0 doesn't match any
		// daily mission (blackjack requires gameType=blackjack, win-3 requires
		// a win, slots requires slots). The weekly
		// gamesTried mission also returns amount=0 because 'craps' is already
		// in the metadata.
		await applyMissionProgress(
			mock.binding,
			'user-nomatch',
			makeEvent({ gameType: 'craps', outcome: 'loss', winsIncrement: 0, handCount: 1 }),
		);

		// Only the two SELECT calls (getOverrides + getProgressRows), no batch.
		expect(mock.calls).toHaveLength(2);
		// No INSERT or batch calls.
		const writes = mock.calls.filter((c) => c.sql.startsWith('INSERT'));
		expect(writes).toHaveLength(0);
	});

	test('issues a dedup INSERT + gamesTried UPSERT for a new gameType on the weekly mission', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));
		mock.onRun('INSERT OR IGNORE INTO mission_game_tried', () => ({ meta: { changes: 1 } }));
		mock.onRun('INSERT INTO mission_progress', () => ({ meta: { changes: 1 } }));

		await applyMissionProgress(
			mock.binding,
			'user-games',
			makeEvent({ gameType: 'blackjack', handCount: 1 }),
		);

		// The weekly-games-3 mission (gamesTried) should produce a dedup INSERT
		// followed by a progress UPSERT.
		const dedupInserts = mock.calls.filter((c) =>
			c.sql.startsWith('INSERT OR IGNORE INTO mission_game_tried'),
		);
		expect(dedupInserts.length).toBeGreaterThanOrEqual(1);
		// The dedup INSERT should bind the gameType.
		const weeklyDedup = dedupInserts.find((c) => c.args.includes('weekly-games-3'));
		expect(weeklyDedup).toBeDefined();
		expect(weeklyDedup!.args).toContain('blackjack');
	});

	test('does NOT issue a gamesTried dedup INSERT when the gameType is already in metadata', async () => {
		const mock = makeMockD1();
		const weeklyKey = getWeeklyPeriodKey();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		// Return existing progress for weekly-games-3 with metadata ['blackjack'].
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'weekly-games-3',
					periodKey: weeklyKey,
					progress: 1,
					metadataJson: '["blackjack"]',
					completedAt: null,
					claimedAt: null,
				},
			],
		}));
		mock.onRun('INSERT OR IGNORE INTO mission_game_tried', () => ({ meta: { changes: 0 } }));
		mock.onRun('INSERT INTO mission_progress', () => ({ meta: { changes: 0 } }));

		// Same gameType as existing metadata — computeIncrement returns amount=0
		// for gamesTried, so no statement is pushed for weekly-games-3.
		await applyMissionProgress(
			mock.binding,
			'user-dedup',
			makeEvent({ gameType: 'blackjack', handCount: 1 }),
		);

		// The weekly-games-3 dedup INSERT should NOT be in the calls.
		const weeklyDedup = mock.calls.find(
			(c) =>
				c.sql.startsWith('INSERT OR IGNORE INTO mission_game_tried') &&
				c.args.includes('weekly-games-3'),
		);
		expect(weeklyDedup).toBeUndefined();
	});

	test('issues a batch with an override applied to the active daily missions', async () => {
		const mock = makeMockD1();
		// getOverrides → one override replacing daily-blackjack-5 with daily-craps-3
		mock.onAll('SELECT originalMissionDefId', () => ({
			results: [
				{
					originalMissionDefId: 'daily-blackjack-5',
					replacementMissionDefId: 'daily-craps-3',
				},
			],
		}));
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));
		mock.onRun('INSERT OR IGNORE INTO mission_game_tried', () => ({ meta: { changes: 1 } }));
		mock.onRun('INSERT INTO mission_progress', () => ({ meta: { changes: 1 } }));

		// A craps event should now match the replacement mission daily-craps-3
		// (handsPlayed, gameType=craps).
		await applyMissionProgress(
			mock.binding,
			'user-override',
			makeEvent({ gameType: 'craps', handCount: 1 }),
		);

		// There should be a progress INSERT for daily-craps-3 (the replacement).
		const crapsProgress = mock.calls.filter(
			(c) => c.sql.startsWith('INSERT INTO mission_progress') && c.args.includes('daily-craps-3'),
		);
		expect(crapsProgress.length).toBeGreaterThanOrEqual(1);
		// And NO progress INSERT for the replaced daily-blackjack-5.
		const bjProgress = mock.calls.filter(
			(c) =>
				c.sql.startsWith('INSERT INTO mission_progress') && c.args.includes('daily-blackjack-5'),
		);
		expect(bjProgress).toHaveLength(0);
	});
});

describe('buildProgressUpsertSQL (mocked D1)', () => {
	function makeDef(overrides: Partial<MissionDefinition> = {}): MissionDefinition {
		return {
			id: 'daily-blackjack-5',
			period: 'daily',
			metric: { kind: 'handsPlayed', gameType: 'blackjack' },
			target: 5,
			rewardChips: 500,
			icon: 'star',
			...overrides,
		};
	}

	test('produces an INSERT ... ON CONFLICT DO UPDATE statement with correct bind params', () => {
		const mock = makeMockD1();
		const def = makeDef();
		const stmt = buildProgressUpsertSQL(mock.binding, 'user-1', def, '2026-07-27', 1, null, 1000);
		// The returned object is a bound statement from our mock.
		expect(stmt).toHaveProperty('sql');
		expect(stmt).toHaveProperty('args');
		// Access the internal properties via the mock's bound statement shape.
		const bound = stmt as unknown as { sql: string; args: unknown[] };
		expect(bound.sql).toContain('INSERT INTO mission_progress');
		expect(bound.sql).toContain('ON CONFLICT');
		expect(bound.args).toEqual(['user-1', 'daily-blackjack-5', '2026-07-27', 1, null]);
	});

	test('uses nowSeconds as the completedAt literal when amount >= target', () => {
		const mock = makeMockD1();
		const def = makeDef({ target: 5 });
		const stmt = buildProgressUpsertSQL(mock.binding, 'user-2', def, '2026-07-27', 5, null, 9999);
		const bound = stmt as unknown as { sql: string };
		// completedClause is `${nowSeconds}` (the literal 9999) when
		// clampedAmount >= target. The VALUES clause is
		// `VALUES (?, ?, ?, ?, ?, 9999, NULL)` — 5 bind params + the
		// completedAt literal + a NULL for claimedAt.
		expect(bound.sql).toContain('9999, NULL)');
	});

	test('uses NULL as the completedAt literal when amount < target', () => {
		const mock = makeMockD1();
		const def = makeDef({ target: 5 });
		const stmt = buildProgressUpsertSQL(mock.binding, 'user-3', def, '2026-07-27', 1, null, 9999);
		const bound = stmt as unknown as { sql: string };
		// completedClause is 'NULL' when clampedAmount < target. The VALUES
		// clause is `VALUES (?, ?, ?, ?, ?, NULL, NULL)` — 5 bind params +
		// NULL for completedAt + NULL for claimedAt.
		expect(bound.sql).toContain('?, ?, ?, ?, ?, NULL, NULL)');
		// The nowSeconds literal should NOT appear in the VALUES clause
		// (it only appears in the CASE WHEN ... THEN clause).
		expect(bound.sql).not.toContain('9999, NULL)');
	});
});

describe('buildGamesTriedUpsertSQL (mocked D1)', () => {
	function makeDef(overrides: Partial<MissionDefinition> = {}): MissionDefinition {
		return {
			id: 'weekly-games-3',
			period: 'weekly',
			metric: { kind: 'gamesTried' },
			target: 3,
			rewardChips: 2000,
			icon: 'calendar',
			...overrides,
		};
	}

	test('produces an INSERT with COUNT(*) subquery and 10 bind params', () => {
		const mock = makeMockD1();
		const def = makeDef();
		const stmt = buildGamesTriedUpsertSQL(
			mock.binding,
			'user-1',
			def,
			'2026-W30',
			'["blackjack"]',
			1000,
		);
		const bound = stmt as unknown as { sql: string; args: unknown[] };
		expect(bound.sql).toContain('INSERT INTO mission_progress');
		expect(bound.sql).toContain('SELECT COUNT(*) FROM mission_game_tried');
		expect(bound.sql).toContain('ON CONFLICT');
		// 10 bind params: userId, defId, periodKey (for VALUES COUNT subquery),
		// userId, defId, periodKey (for completedAt CASE subquery), metadataJson,
		// userId, defId, periodKey (for ON CONFLICT COUNT subquery).
		expect(bound.args).toEqual([
			'user-1',
			'weekly-games-3',
			'2026-W30',
			'user-1',
			'weekly-games-3',
			'2026-W30',
			'["blackjack"]',
			'user-1',
			'weekly-games-3',
			'2026-W30',
		]);
	});

	test('embeds the target and nowSeconds as SQL literals', () => {
		const mock = makeMockD1();
		const def = makeDef({ target: 3 });
		const stmt = buildGamesTriedUpsertSQL(mock.binding, 'user-2', def, '2026-W30', null, 5555);
		const bound = stmt as unknown as { sql: string };
		// target appears as a literal in the >= comparison.
		expect(bound.sql).toContain('>= 3');
		// nowSeconds appears as a literal in the THEN clause.
		expect(bound.sql).toContain('5555');
	});
});
