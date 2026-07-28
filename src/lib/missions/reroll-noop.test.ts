/**
 * Mocked unit test for the `no-replacement` defensive branch of performReroll.
 *
 * This branch is structurally unreachable through Miniflare integration: the
 * replacement pool is `ALL_DAILY_DEFINITIONS` (7) minus `activeDaily`, and
 * `activeDaily` is always exactly the 4 DEFAULT_DAILY_MISSIONS (applyOverrides
 * maps defaults 1:1 with overrides), so the pool always holds 3 candidates when
 * the one-per-day guard (overrides.length === 0) has passed.
 *
 * To exercise the empty-pool branch we mock `./board` so `getReplacementPool`
 * returns `[]`, and supply a tiny fake D1 whose mission_progress SELECT returns
 * null (target mission uncompleted). This file is kept separate from
 * `reroll.test.ts` because `mock.module` is file-scoped and would replace the
 * real `getOverrides` used by the Miniflare integration tests there.
 */

import { describe, expect, test, mock } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';

// mock.module must register before the SUT imports `./board`. The factory
// returns a controllable pool so we can force the empty-pool branch while
// still passing the one-per-day guard (getOverrides -> []) and the
// applyOverrides passthrough.
let poolOverride: unknown[] = [{ id: 'sentinel' }];

mock.module('./board', () => ({
	getOverrides: async () => [],
	applyOverrides: (defaults: unknown[]) => defaults,
	getReplacementPool: () => poolOverride,
}));

const { performReroll } = await import('./reroll');

/** Minimal fake D1: the mission_progress SELECT returns no row; the override
 * INSERT reports 1 row affected so the ON CONFLICT race guard treats it as
 * a successful insert. */
function makeFakeD1(): D1Database {
	const chain = {
		bind: () => ({
			first: async () => null,
			run: async () => ({ meta: { changes: 1 } }),
			all: async () => ({ results: [] }),
		}),
	};
	return { prepare: () => chain } as unknown as D1Database;
}

/** Variant where the override INSERT reports 0 rows affected — emulates the
 * ON CONFLICT DO NOTHING race loser (another request inserted the day's
 * override between our read and write). Used to exercise the changes === 0
 * race-guard branch in performReroll. */
function makeFakeD1RaceLoser(): D1Database {
	const chain = {
		bind: () => ({
			first: async () => null,
			run: async () => ({ meta: { changes: 0 } }),
			all: async () => ({ results: [] }),
		}),
	};
	return { prepare: () => chain } as unknown as D1Database;
}

describe('performReroll no-replacement branch (mocked board)', () => {
	test('returns no-replacement when the pool is empty', async () => {
		poolOverride = [];

		const result = await performReroll(makeFakeD1(), 'user-empty', 'daily-blackjack-5');
		expect(result.status).toBe('no-replacement');
		expect(result.originalMissionDefId).toBeUndefined();
		expect(result.replacementMissionDefId).toBeUndefined();
	});

	test('still rerolls when the pool is non-empty (sanity check against the mock)', async () => {
		poolOverride = [{ id: 'daily-craps-3' }];

		const result = await performReroll(makeFakeD1(), 'user-mock-ok', 'daily-blackjack-5');
		expect(result.status).toBe('rerolled');
		expect(result.replacementMissionDefId).toBe('daily-craps-3');
	});

	test('returns reroll-used when the INSERT ON CONFLICT reports 0 rows (race loser)', async () => {
		poolOverride = [{ id: 'daily-craps-3' }];

		const result = await performReroll(
			makeFakeD1RaceLoser(),
			'user-race-loser',
			'daily-blackjack-5',
		);
		expect(result.status).toBe('reroll-used');
		expect(result.originalMissionDefId).toBeUndefined();
		expect(result.replacementMissionDefId).toBeUndefined();
	});
});
