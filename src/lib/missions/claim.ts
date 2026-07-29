import type { D1Database } from '@cloudflare/workers-types';
import { getMissionDef } from './registry';
import { getDailyPeriodKey, getWeeklyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';
import { computeStreakTransition, getDayOfCycle } from './streak';

export interface ClaimResult {
	status: 'completed' | 'already-claimed' | 'not-completed' | 'not-found';
	missionDefId: string;
	rewardChips: number;
	chipBalance: number;
}

export interface StreakClaimResult {
	status: 'completed' | 'already-claimed';
	currentStreak: number;
	longestStreak: number;
	dayOfCycle: number;
	rewardChips: number;
	chipBalance: number;
}

export async function claimMission(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	currentChipBalance: number,
): Promise<ClaimResult> {
	const def = getMissionDef(missionDefId);
	if (!def) {
		return { status: 'not-found', missionDefId, rewardChips: 0, chipBalance: currentChipBalance };
	}

	const periodKey = def.period === 'daily' ? getDailyPeriodKey() : getWeeklyPeriodKey();
	const nowSeconds = Math.trunc(Date.now() / 1000);

	// In-SQL changes() cascade: the grant UPDATE gates on the claim UPDATE's changes().
	// D1 batch runs ALL statements, but the WHERE changes() = 1 on the grant
	// makes it a no-op when the claim didn't match. Atomic — no crash window.
	// This matches the chip-sync cascade pattern (chip-sync-batch-sql.ts).
	//
	// Reroll race guard (daily only): a game-progress update can snapshot the
	// original daily mission as active, race with a successful reroll that
	// installs a replacement, and then complete the now-replaced original.
	// Without this guard, claimMission() would still pay the original because
	// it verified only registry membership + the progress row. The NOT EXISTS
	// subquery makes the claim a no-op when the mission has been rerolled away,
	// so the grant cascade (changes() = 1) also no-ops. Only daily missions can
	// be rerolled; weekly missions have no override path.
	const rerollGuard =
		def.period === 'daily'
			? ` AND NOT EXISTS (SELECT 1 FROM mission_override WHERE userId = ? AND periodKey = ? AND originalMissionDefId = ?)`
			: '';
	const claimStmt = d1
		.prepare(
			`UPDATE mission_progress
			 SET claimedAt = ?
			 WHERE userId = ? AND missionDefId = ? AND periodKey = ?
			   AND claimedAt IS NULL AND progress >= ?${rerollGuard}`,
		)
		.bind(
			...(def.period === 'daily'
				? [nowSeconds, userId, missionDefId, periodKey, def.target, userId, periodKey, missionDefId]
				: [nowSeconds, userId, missionDefId, periodKey, def.target]),
		);

	const grantStmt = d1
		.prepare(`UPDATE user SET chipBalance = chipBalance + ? WHERE id = ? AND changes() = 1`)
		.bind(def.rewardChips, userId);

	const results = await d1.batch([claimStmt, grantStmt]);
	const claimChanges = results[0]?.meta?.changes ?? 0;

	if (claimChanges === 1) {
		return {
			status: 'completed',
			missionDefId,
			rewardChips: def.rewardChips,
			chipBalance: currentChipBalance + def.rewardChips,
		};
	}

	// Claim didn't fire — distinguish already-claimed from not-completed
	const row = await d1
		.prepare(
			`SELECT claimedAt FROM mission_progress WHERE userId = ? AND missionDefId = ? AND periodKey = ?`,
		)
		.bind(userId, missionDefId, periodKey)
		.first<{ claimedAt: number | null }>();

	if (row?.claimedAt) {
		return {
			status: 'already-claimed',
			missionDefId,
			rewardChips: 0,
			chipBalance: currentChipBalance,
		};
	}
	return { status: 'not-completed', missionDefId, rewardChips: 0, chipBalance: currentChipBalance };
}

export async function claimLogin(
	d1: D1Database,
	userId: string,
	currentChipBalance: number,
): Promise<StreakClaimResult> {
	const today = getDailyPeriodKey();
	const yesterday = getDailyPeriodKeyForYesterday();

	// Read current streak to compute transition values (not for race guard —
	// the WHERE clause on the upsert handles the race)
	const existing = await d1
		.prepare(
			`SELECT currentStreak, longestStreak, lastClaimPeriodKey FROM login_streak WHERE userId = ?`,
		)
		.bind(userId)
		.first<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string }>();

	const currentStreak = existing?.currentStreak ?? 0;
	const longestStreak = existing?.longestStreak ?? 0;
	const lastClaimPeriodKey = existing?.lastClaimPeriodKey ?? '';

	// Fast path: already claimed today
	if (lastClaimPeriodKey === today) {
		return {
			status: 'already-claimed',
			currentStreak,
			longestStreak,
			dayOfCycle: getDayOfCycle(currentStreak),
			rewardChips: 0,
			chipBalance: currentChipBalance,
		};
	}

	const transition = computeStreakTransition({
		currentStreak,
		longestStreak,
		lastClaimPeriodKey,
		today,
		yesterday,
	});

	// In-SQL changes() cascade: always use the upsert form.
	// The WHERE clause gates on lastClaimPeriodKey != today (handles races).
	// The grant gates on changes() = 1 from the upsert.
	const streakStmt = d1
		.prepare(
			`INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT (userId) DO UPDATE SET
			   currentStreak = excluded.currentStreak,
			   longestStreak = excluded.longestStreak,
			   lastClaimPeriodKey = excluded.lastClaimPeriodKey
			 WHERE login_streak.lastClaimPeriodKey != ?`,
		)
		.bind(userId, transition.newStreak, transition.newLongest, today, today);

	const grantStmt = d1
		.prepare(`UPDATE user SET chipBalance = chipBalance + ? WHERE id = ? AND changes() = 1`)
		.bind(transition.reward, userId);

	const results = await d1.batch([streakStmt, grantStmt]);
	const streakChanges = results[0]?.meta?.changes ?? 0;

	if (streakChanges === 1) {
		return {
			status: 'completed',
			currentStreak: transition.newStreak,
			longestStreak: transition.newLongest,
			dayOfCycle: transition.dayOfCycle,
			rewardChips: transition.reward,
			chipBalance: currentChipBalance + transition.reward,
		};
	}

	// Race: another request claimed between our read and write
	return {
		status: 'already-claimed',
		currentStreak,
		longestStreak,
		dayOfCycle: getDayOfCycle(currentStreak),
		rewardChips: 0,
		chipBalance: currentChipBalance,
	};
}
