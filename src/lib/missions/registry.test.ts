import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_DAILY_MISSIONS,
	REROLL_POOL_DAILY,
	DEFAULT_WEEKLY_MISSIONS,
	ALL_DAILY_DEFINITIONS,
	getMissionDef,
} from './registry';

describe('mission registry', () => {
	test('default daily missions has 4 entries', () => {
		expect(DEFAULT_DAILY_MISSIONS).toHaveLength(4);
	});

	test('reroll pool has at least 2 entries', () => {
		expect(REROLL_POOL_DAILY.length).toBeGreaterThanOrEqual(2);
	});

	test('weekly has 1 entry', () => {
		expect(DEFAULT_WEEKLY_MISSIONS).toHaveLength(1);
	});

	test('all daily definitions = default + reroll pool, no duplicates', () => {
		const ids = ALL_DAILY_DEFINITIONS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.length).toBe(DEFAULT_DAILY_MISSIONS.length + REROLL_POOL_DAILY.length);
	});

	test('getMissionDef finds by id', () => {
		expect(getMissionDef('daily-blackjack-5')).toBeDefined();
		expect(getMissionDef('weekly-games-3')).toBeDefined();
		expect(getMissionDef('nonexistent')).toBeUndefined();
	});

	test('all daily missions have period daily, weekly have weekly', () => {
		for (const m of DEFAULT_DAILY_MISSIONS) {
			expect(m.period).toBe('daily');
		}
		for (const m of REROLL_POOL_DAILY) {
			expect(m.period).toBe('daily');
		}
		for (const m of DEFAULT_WEEKLY_MISSIONS) {
			expect(m.period).toBe('weekly');
		}
	});

	test('all missions have positive target and reward', () => {
		for (const m of [...ALL_DAILY_DEFINITIONS, ...DEFAULT_WEEKLY_MISSIONS]) {
			expect(m.target).toBeGreaterThan(0);
			expect(m.rewardChips).toBeGreaterThan(0);
		}
	});

	test('no reroll pool mission is in default daily set', () => {
		const defaultIds = new Set(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
		for (const m of REROLL_POOL_DAILY) {
			expect(defaultIds.has(m.id)).toBe(false);
		}
	});
});
