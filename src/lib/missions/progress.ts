import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { MissionDefinition, MissionGameEvent } from './types';
import { DEFAULT_DAILY_MISSIONS, DEFAULT_WEEKLY_MISSIONS } from './registry';
import { getDailyPeriodKey, getWeeklyPeriodKey } from './periods';
import { applyOverrides, getOverrides, getProgressRows } from './board';

export interface ExistingProgress {
	progress: number;
	metadataJson: string | null;
}

export interface IncrementResult {
	amount: number;
	metadata?: string[];
}

export function clampProgress(progress: number, target: number): number {
	return Math.max(0, Math.min(progress, target));
}

export function computeIncrement(
	def: MissionDefinition,
	event: MissionGameEvent,
	existing: ExistingProgress | null,
): IncrementResult {
	const metric = def.metric;

	switch (metric.kind) {
		case 'handsPlayed': {
			if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
			if (!metric.gameType && event.gameType === 'poker_mp') return { amount: 0 };
			return { amount: event.handCount };
		}
		case 'roundsWon': {
			if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
			const wins = event.winsIncrement > 0 ? event.winsIncrement : event.outcome === 'win' ? 1 : 0;
			return { amount: wins };
		}
		case 'spinsCompleted': {
			if (event.gameType !== 'slots') return { amount: 0 };
			return { amount: event.handCount };
		}
		case 'mpHandsCompleted': {
			if (event.gameType !== 'poker_mp') return { amount: 0 };
			return { amount: 1 };
		}
		case 'gamesTried': {
			const existingGames = parseMetadata(existing?.metadataJson);
			if (existingGames.includes(event.gameType)) return { amount: 0 };
			return { amount: 1, metadata: [...existingGames, event.gameType] };
		}
	}
}

export function parseMetadata(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

export async function applyMissionProgress(
	d1: D1Database,
	userId: string,
	event: MissionGameEvent,
): Promise<void> {
	if (!event.outcome) return;

	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();

	const overrides = await getOverrides(d1, userId, dailyKey);
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const allActive = [...activeDaily, ...DEFAULT_WEEKLY_MISSIONS];

	const activeDefIds = allActive.map((d) => d.id);
	const progressMap = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);

	const statements: D1PreparedStatement[] = [];
	const nowSeconds = Math.trunc(Date.now() / 1000);

	for (const def of allActive) {
		const periodKey = def.period === 'daily' ? dailyKey : weeklyKey;
		const existing = progressMap.get(`${def.id}:${periodKey}`) ?? null;
		const existingNormalized = existing
			? { progress: existing.progress, metadataJson: existing.metadataJson }
			: null;
		const result = computeIncrement(def, event, existingNormalized);
		if (result.amount === 0) continue;

		const currentProgress = existing?.progress ?? 0;
		const newProgressRaw = currentProgress + result.amount;
		const newProgress = clampProgress(newProgressRaw, def.target);
		const metadataJson = result.metadata
			? JSON.stringify(result.metadata)
			: (existing?.metadataJson ?? null);

		const stmt = buildProgressUpsertSQL(
			d1,
			userId,
			def,
			periodKey,
			result.amount,
			newProgress,
			metadataJson,
			nowSeconds,
		);
		statements.push(stmt);
	}

	if (statements.length > 0) {
		await d1.batch(statements);
	}
}

/**
 * Build the mission_progress UPSERT.
 *
 * Two write strategies, selected by metric kind:
 *
 *  - Atomic increment (default): passes `amount` as `excluded.progress` and
 *    the ON CONFLICT branch computes `MIN(progress + excluded.progress,
 *    target)` directly in SQL. This closes the lost-update race where two
 *    concurrent requests both read the same stale `currentProgress`, each
 *    compute the same absolute `newProgress`, and the second overwrites the
 *    first. With the SQL-side increment the second call still adds its delta
 *    on top of the committed value. The first-write INSERT path stores
 *    `clampProgress(amount, target)` directly (0 + amount clamped).
 *
 *  - Absolute write (`gamesTried`): the metric deduplicates via metadata, so
 *    the increment must be computed JS-side from a read-then-write of the
 *    metadata blob. This is inherently non-atomic and acknowledged in the
 *    spec; for this path we keep the legacy absolute-write semantics, passing
 *    `newProgress` as `excluded.progress`.
 */
export function buildProgressUpsertSQL(
	d1: D1Database,
	userId: string,
	def: MissionDefinition,
	periodKey: string,
	amount: number,
	newProgress: number,
	metadataJson: string | null,
	nowSeconds: number,
): D1PreparedStatement {
	const target = def.target;
	const isAbsolute = def.metric.kind === 'gamesTried';

	if (isAbsolute) {
		const completedClause = newProgress >= target ? `${nowSeconds}` : 'NULL';
		return d1
			.prepare(
				`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
				 VALUES (?, ?, ?, ?, ?, ${completedClause}, NULL)
				 ON CONFLICT (userId, missionDefId, periodKey) DO UPDATE SET
				   progress = excluded.progress,
				   metadataJson = excluded.metadataJson,
				   completedAt = CASE
				     WHEN excluded.progress >= ${target} AND mission_progress.completedAt IS NULL
				     THEN ${nowSeconds}
				     ELSE mission_progress.completedAt
				   END`,
			)
			.bind(userId, def.id, periodKey, newProgress, metadataJson);
	}

	// Atomic increment path. excluded.progress is the increment amount; the
	// INSERT values store it clamped to target so a single oversized event
	// never persists progress > target.
	const clampedAmount = Math.min(amount, target);
	const completedClause = clampedAmount >= target ? `${nowSeconds}` : 'NULL';
	return d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 VALUES (?, ?, ?, ?, ?, ${completedClause}, NULL)
			 ON CONFLICT (userId, missionDefId, periodKey) DO UPDATE SET
			   progress = MIN(mission_progress.progress + excluded.progress, ${target}),
			   metadataJson = excluded.metadataJson,
			   completedAt = CASE
			     WHEN MIN(mission_progress.progress + excluded.progress, ${target}) >= ${target} AND mission_progress.completedAt IS NULL
			     THEN ${nowSeconds}
			     ELSE mission_progress.completedAt
			   END`,
		)
		.bind(userId, def.id, periodKey, clampedAmount, metadataJson);
}
