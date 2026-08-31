import type { D1Database } from '@cloudflare/workers-types';
import type { MissionDefinition, MissionView, BoardState, StreakView } from './types';
import {
	DEFAULT_DAILY_MISSIONS,
	DEFAULT_WEEKLY_MISSIONS,
	ALL_DAILY_DEFINITIONS,
	getMissionDef,
} from './registry';
import { computeEffectiveStreakFromStored } from './streak';
import { clampProgress } from './progress';
import {
	getDailyPeriodKey,
	getWeeklyPeriodKey,
	getNextDailyReset,
	getNextWeeklyReset,
} from './periods';

export interface OverrideRow {
	originalMissionDefId: string;
	replacementMissionDefId: string;
}

export interface ProgressRow {
	missionDefId: string;
	periodKey: string;
	progress: number;
	metadataJson: string | null;
	completedAt: Date | null;
	claimedAt: Date | null;
}

export function applyOverrides(
	defaults: MissionDefinition[],
	overrides: OverrideRow[],
): MissionDefinition[] {
	const overrideMap = new Map(
		overrides.map((o) => [o.originalMissionDefId, o.replacementMissionDefId]),
	);
	return defaults.map((def) => {
		const replacementId = overrideMap.get(def.id);
		if (replacementId) {
			const replacement = getMissionDef(replacementId);
			if (replacement) return replacement;
		}
		return def;
	});
}

export function getReplacementPool(activeMissionIds: string[]): MissionDefinition[] {
	const activeSet = new Set(activeMissionIds);
	return ALL_DAILY_DEFINITIONS.filter((def) => !activeSet.has(def.id));
}

export function buildMissionView(
	def: MissionDefinition,
	progress: {
		progress: number;
		completedAt: Date | null;
		claimedAt: Date | null;
		metadataJson: string | null;
	},
	isOverride: boolean,
): MissionView {
	const clamped = clampProgress(progress.progress, def.target);
	// Derive `completed` from the clamped value, not the raw progress, so the
	// two fields can never disagree if clampProgress ever changes semantics.
	// Today clampProgress = max(0, min(p, target)), so this is equivalent to
	// `raw >= target` for all target > 0, but keeps a single source of truth.
	const completed = clamped >= def.target;
	const claimed = progress.claimedAt !== null;
	return {
		missionDefId: def.id,
		icon: def.icon,
		period: def.period,
		progress: clamped,
		target: def.target,
		completed,
		claimed,
		claimable: completed && !claimed,
		rewardChips: def.rewardChips,
		isOverride,
	};
}

// ── DB-touching functions ──────────────────────────────────────────────────

export async function getOverrides(
	d1: D1Database,
	userId: string,
	periodKey: string,
): Promise<OverrideRow[]> {
	const result = await d1
		.prepare(
			`SELECT originalMissionDefId, replacementMissionDefId FROM mission_override WHERE userId = ? AND periodKey = ?`,
		)
		.bind(userId, periodKey)
		.all<OverrideRow>();
	return result.results ?? [];
}

export async function getProgressRows(
	d1: D1Database,
	userId: string,
	defIds: string[],
	dailyKey: string,
	weeklyKey: string,
): Promise<Map<string, ProgressRow>> {
	const map = new Map<string, ProgressRow>();
	if (defIds.length === 0) return map;

	const placeholders = defIds.map(() => '?').join(',');
	const rows = await d1
		.prepare(
			`SELECT missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt FROM mission_progress WHERE userId = ? AND missionDefId IN (${placeholders}) AND (periodKey = ? OR periodKey = ?)`,
		)
		.bind(userId, ...defIds, dailyKey, weeklyKey)
		.all();

	for (const row of rows.results ?? []) {
		const r = row as Record<string, unknown>;
		const key = `${r.missionDefId}:${r.periodKey}`;
		map.set(key, {
			missionDefId: r.missionDefId as string,
			periodKey: r.periodKey as string,
			progress: r.progress as number,
			metadataJson: (r.metadataJson as string | null) ?? null,
			completedAt: r.completedAt ? new Date((r.completedAt as number) * 1000) : null,
			claimedAt: r.claimedAt ? new Date((r.claimedAt as number) * 1000) : null,
		});
	}
	return map;
}

export async function getBoardState(
	d1: D1Database,
	userId: string,
	chipBalance: number,
): Promise<BoardState> {
	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();

	// The login_streak query is independent of overrides/progress, so start
	// it alongside getOverrides and await both together.
	const [overrides, streakRow] = await Promise.all([
		getOverrides(d1, userId, dailyKey),
		d1
			.prepare(
				`SELECT currentStreak, longestStreak, lastClaimPeriodKey FROM login_streak WHERE userId = ? LIMIT 1`,
			)
			.bind(userId)
			.first<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string }>(),
	]);
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const activeDefIds = [...activeDaily, ...DEFAULT_WEEKLY_MISSIONS].map((d) => d.id);
	const progressMap = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);

	const overrideIds = new Set(overrides.map((o) => o.replacementMissionDefId));

	const dailyViews: MissionView[] = activeDaily.map((def) => {
		const progress = progressMap.get(`${def.id}:${dailyKey}`) ?? emptyProgress();
		return buildMissionView(def, progress, overrideIds.has(def.id));
	});

	const weeklyViews: MissionView[] = DEFAULT_WEEKLY_MISSIONS.map((def) => {
		const progress = progressMap.get(`${def.id}:${weeklyKey}`) ?? emptyProgress();
		return buildMissionView(def, progress, false);
	});

	const effective = computeEffectiveStreakFromStored(streakRow ?? null);

	const streak: StreakView = {
		current: effective.displayStreak,
		longest: streakRow?.longestStreak ?? 0,
		claimableToday: effective.claimableToday,
		dayOfCycle: effective.dayOfCycle,
		rewardPreview: effective.rewardPreview,
		lastClaimPeriodKey: streakRow?.lastClaimPeriodKey ?? '',
	};

	return {
		streak,
		daily: dailyViews,
		weekly: weeklyViews,
		rerollAvailable: overrides.length === 0,
		nextDailyReset: getNextDailyReset().toISOString(),
		nextWeeklyReset: getNextWeeklyReset().toISOString(),
		chipBalance,
	};
}

function emptyProgress(): ProgressRow {
	return {
		missionDefId: '',
		periodKey: '',
		progress: 0,
		metadataJson: null,
		completedAt: null,
		claimedAt: null,
	};
}
