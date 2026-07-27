import { describe, expect, test } from 'bun:test';
import { applyOverrides, getReplacementPool, buildMissionView } from './board';
import { DEFAULT_DAILY_MISSIONS, REROLL_POOL_DAILY } from './registry';
import type { MissionDefinition } from './types';

describe('applyOverrides', () => {
	test('no overrides → returns default missions', () => {
		const result = applyOverrides(DEFAULT_DAILY_MISSIONS, []);
		expect(result.map((m) => m.id)).toEqual(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
	});

	test('override replaces original with replacement def', () => {
		const overrides = [
			{
				originalMissionDefId: DEFAULT_DAILY_MISSIONS[0].id,
				replacementMissionDefId: REROLL_POOL_DAILY[0].id,
			},
		];
		const result = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
		expect(result[0].id).toBe(REROLL_POOL_DAILY[0].id);
		expect(result[1].id).toBe(DEFAULT_DAILY_MISSIONS[1].id);
	});

	test('override for non-existent original is ignored', () => {
		const overrides = [
			{
				originalMissionDefId: 'nonexistent',
				replacementMissionDefId: REROLL_POOL_DAILY[0].id,
			},
		];
		const result = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
		expect(result.map((m) => m.id)).toEqual(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
	});
});

describe('getReplacementPool', () => {
	test('excludes currently active mission IDs', () => {
		const activeIds = DEFAULT_DAILY_MISSIONS.map((m) => m.id);
		const pool = getReplacementPool(activeIds);
		for (const def of pool) {
			expect(activeIds).not.toContain(def.id);
		}
		expect(pool.length).toBeGreaterThan(0);
	});

	test('excludes replacement already drawn', () => {
		const activeIds = [
			...DEFAULT_DAILY_MISSIONS.slice(1).map((m) => m.id),
			REROLL_POOL_DAILY[0].id,
		];
		const pool = getReplacementPool(activeIds);
		expect(pool.find((m) => m.id === REROLL_POOL_DAILY[0].id)).toBeUndefined();
	});

	test('returns empty when all are active', () => {
		const allIds = [...DEFAULT_DAILY_MISSIONS, ...REROLL_POOL_DAILY].map((m) => m.id);
		expect(getReplacementPool(allIds)).toEqual([]);
	});
});

describe('buildMissionView', () => {
	test('not started → progress 0, not completed', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 0, completedAt: null, claimedAt: null, metadataJson: null },
			false,
		);
		expect(view.progress).toBe(0);
		expect(view.completed).toBe(false);
		expect(view.claimed).toBe(false);
		expect(view.claimable).toBe(false);
	});

	test('completed but unclaimed → claimable', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 5, completedAt: new Date(), claimedAt: null, metadataJson: null },
			false,
		);
		expect(view.completed).toBe(true);
		expect(view.claimable).toBe(true);
	});

	test('completed and claimed → not claimable', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 5, completedAt: new Date(), claimedAt: new Date(), metadataJson: null },
			false,
		);
		expect(view.claimable).toBe(false);
	});

	test('isOverride flag passed through', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 0, completedAt: null, claimedAt: null, metadataJson: null },
			true,
		);
		expect(view.isOverride).toBe(true);
	});

	// NOTE: getBoardState builds its override flag Set from REPLACEMENT IDs
	// (o.replacementMissionDefId), not original IDs, because applyOverrides
	// swaps each default for its replacement def — so the active board only
	// ever contains replacement IDs for rerolled slots. Default and reroll-pool
	// IDs are disjoint, so a Set of original IDs would never match. This test
	// guards that the same logic that getBoardState uses produces isOverride=true
	// for a replacement def.
	test('overrideIds set from replacement IDs marks rerolled mission as override', () => {
		const overrides = [
			{
				originalMissionDefId: DEFAULT_DAILY_MISSIONS[0].id,
				replacementMissionDefId: REROLL_POOL_DAILY[0].id,
			},
		];
		const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
		// Mirror getBoardState's override lookup (fixed to use replacement IDs).
		const overrideIds = new Set(overrides.map((o) => o.replacementMissionDefId));
		const replacedDef = activeDaily[0];
		expect(replacedDef.id).toBe(REROLL_POOL_DAILY[0].id);
		expect(overrideIds.has(replacedDef.id)).toBe(true);
		const view = buildMissionView(
			replacedDef,
			{ progress: 0, completedAt: null, claimedAt: null, metadataJson: null },
			overrideIds.has(replacedDef.id),
		);
		expect(view.isOverride).toBe(true);
	});
});
