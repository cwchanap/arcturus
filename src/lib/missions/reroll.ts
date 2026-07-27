import type { D1Database } from '@cloudflare/workers-types';
import { getDailyPeriodKey } from './periods';
import { getOverrides, applyOverrides, getReplacementPool } from './board';
import { DEFAULT_DAILY_MISSIONS, getMissionDef } from './registry';

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

	await d1
		.prepare(
			`INSERT INTO mission_override (userId, periodKey, originalMissionDefId, replacementMissionDefId, rerolledAt)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(userId, periodKey, missionDefId, replacement.id, nowSeconds)
		.run();

	return {
		status: 'rerolled',
		originalMissionDefId: missionDefId,
		replacementMissionDefId: replacement.id,
	};
}
