import type { D1Database } from '@cloudflare/workers-types';
import { getDailyPeriodKey } from './periods';
import { getOverrides, applyOverrides, getReplacementPool } from './board';
import { DEFAULT_DAILY_MISSIONS, getMissionDef } from './registry';

// The set of mission ids that can appear on a user's daily board before any
// reroll. Reroll must only accept ids from this set: the override row stores
// `originalMissionDefId` and `applyOverrides` only maps ids that exist in
// DEFAULT_DAILY_MISSIONS. Accepting a reroll-pool id (e.g. `daily-craps-3`)
// would consume the user's one daily reroll and create an orphan override that
// `applyOverrides` never reads, leaving the board unchanged.
const BOARD_DAILY_IDS: ReadonlySet<string> = new Set(DEFAULT_DAILY_MISSIONS.map((d) => d.id));

export interface RerollResult {
	status: 'rerolled' | 'reroll-used' | 'already-completed' | 'not-daily' | 'no-replacement';
	originalMissionDefId?: string;
	replacementMissionDefId?: string;
}

export async function performReroll(
	d1: D1Database,
	userId: string,
	missionDefId: string,
): Promise<RerollResult> {
	// Reject ids that aren't on the user's rendered daily board. Checking
	// BOARD_DAILY_IDS (not getMissionDef) prevents rerolling a reroll-pool
	// mission that was never displayed.
	if (!BOARD_DAILY_IDS.has(missionDefId)) {
		return { status: 'not-daily' };
	}
	const def = getMissionDef(missionDefId);
	if (!def || def.period !== 'daily') {
		return { status: 'not-daily' };
	}

	const periodKey = getDailyPeriodKey();

	// Check: one reroll per day
	const overrides = await getOverrides(d1, userId, periodKey);
	if (overrides.length >= 1) {
		return { status: 'reroll-used' };
	}

	// Check: target mission must be uncompleted
	const progress = await d1
		.prepare(
			`SELECT completedAt FROM mission_progress WHERE userId = ? AND missionDefId = ? AND periodKey = ?`,
		)
		.bind(userId, missionDefId, periodKey)
		.first<{ completedAt: number | null }>();

	if (progress?.completedAt) {
		return { status: 'already-completed' };
	}

	// Get replacement pool
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const activeIds = activeDaily.map((d) => d.id);
	const pool = getReplacementPool(activeIds);

	if (pool.length === 0) {
		return { status: 'no-replacement' };
	}

	// Pick random replacement
	const replacement = pool[Math.floor(Math.random() * pool.length)];
	const nowSeconds = Math.trunc(Date.now() / 1000);

	// Race guard: the read-side `overrides.length === 0` check above is
	// necessary but not sufficient — two concurrent reroll requests can both
	// pass it before either INSERT commits. The UNIQUE(userId, periodKey)
	// index on mission_override backs this INSERT ... ON CONFLICT DO NOTHING;
	// the loser sees meta.changes === 0 and is told reroll-used.
	const insertResult = await d1
		.prepare(
			`INSERT INTO mission_override (userId, periodKey, originalMissionDefId, replacementMissionDefId, rerolledAt)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(userId, periodKey) DO NOTHING`,
		)
		.bind(userId, periodKey, missionDefId, replacement.id, nowSeconds)
		.run<{ meta?: { changes?: number } }>();

	const changes = insertResult?.meta?.changes ?? 0;
	if (changes === 0) {
		return { status: 'reroll-used' };
	}

	return {
		status: 'rerolled',
		originalMissionDefId: missionDefId,
		replacementMissionDefId: replacement.id,
	};
}
