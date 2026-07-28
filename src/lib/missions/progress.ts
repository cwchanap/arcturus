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
	await applyMissionProgressBatch(d1, [{ userId, event }]);
}

/**
 * Apply mission progress for multiple users in one call.
 *
 * Used by `/api/mp/settle` so a multiplayer hand settlement updates every
 * player's mission progress with a single D1 write batch instead of N
 * serial per-user round-trips. The read phase (overrides + progress rows)
 * runs per-user via `Promise.all` (the progress defIds depend on each
 * user's overrides, so the reads can't be collapsed into one statement),
 * but all write statements across all users are collected and submitted in
 * one `d1.batch` call.
 *
 * Entries with no `outcome` are skipped (matches the `applyMissionProgress`
 * guard). Duplicate userIds are handled safely — each produces its own
 * upsert statements keyed on (userId, missionDefId, periodKey), and the
 * SQL-side `MIN(progress + excluded.progress, target)` increment is
 * concurrent-safe within the batch.
 */
export async function applyMissionProgressBatch(
	d1: D1Database,
	entries: { userId: string; event: MissionGameEvent }[],
): Promise<void> {
	const valid = entries.filter((e) => e.event.outcome);
	if (valid.length === 0) return;

	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();
	const nowSeconds = Math.trunc(Date.now() / 1000);

	// Read phase: per-user overrides + progress, parallelized across users.
	// The progress defIds depend on each user's overrides (rerolled missions
	// swap in a replacement id), so these reads can't be merged into one
	// statement — but they run concurrently.
	const readResults = await Promise.all(
		valid.map(async ({ userId }) => {
			const overrides = await getOverrides(d1, userId, dailyKey);
			const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
			const allActive = [...activeDaily, ...DEFAULT_WEEKLY_MISSIONS];
			const activeDefIds = allActive.map((d) => d.id);
			const progressMap = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);
			return { userId, allActive, progressMap };
		}),
	);

	// Write phase: collect all statements across all users, submit in one batch.
	const statements: D1PreparedStatement[] = [];
	for (let i = 0; i < valid.length; i++) {
		const { event } = valid[i]!;
		const { userId, allActive, progressMap } = readResults[i]!;
		for (const def of allActive) {
			const periodKey = def.period === 'daily' ? dailyKey : weeklyKey;
			const existing = progressMap.get(`${def.id}:${periodKey}`) ?? null;
			const existingNormalized = existing
				? { progress: existing.progress, metadataJson: existing.metadataJson }
				: null;
			const result = computeIncrement(def, event, existingNormalized);
			if (result.amount === 0) continue;

			const metadataJson = result.metadata
				? JSON.stringify(result.metadata)
				: (existing?.metadataJson ?? null);

			if (def.metric.kind === 'gamesTried') {
				// Per-game dedup: INSERT OR IGNORE a row into mission_game_tried,
				// then UPSERT mission_progress with progress = COUNT(*) from the
				// dedup table. This is concurrent-safe — two requests for
				// different game types both insert their rows, and the COUNT
				// reflects all committed rows. The metadata fast-path in
				// computeIncrement skips the write when the game type is already
				// known, but the dedup table is the source of truth for progress.
				const dedupStmt = d1
					.prepare(
						'INSERT OR IGNORE INTO mission_game_tried (userId, missionDefId, periodKey, gameType, firstTriedAt) VALUES (?, ?, ?, ?, ?)',
					)
					.bind(userId, def.id, periodKey, event.gameType, nowSeconds);
				const progressStmt = buildGamesTriedUpsertSQL(
					d1,
					userId,
					def,
					periodKey,
					metadataJson,
					nowSeconds,
				);
				statements.push(dedupStmt, progressStmt);
			} else {
				const stmt = buildProgressUpsertSQL(
					d1,
					userId,
					def,
					periodKey,
					result.amount,
					metadataJson,
					nowSeconds,
				);
				statements.push(stmt);
			}
		}
	}

	if (statements.length > 0) {
		await d1.batch(statements);
	}
}

/**
 * Build the mission_progress UPSERT for the atomic increment path.
 *
 * Passes `amount` as `excluded.progress` and the ON CONFLICT branch computes
 * `MIN(progress + excluded.progress, target)` directly in SQL. This closes
 * the lost-update race where two concurrent requests both read the same stale
 * `currentProgress`, each compute the same absolute `newProgress`, and the
 * second overwrites the first. With the SQL-side increment the second call
 * still adds its delta on top of the committed value. The first-write INSERT
 * path stores `clampProgress(amount, target)` directly (0 + amount clamped).
 */
export function buildProgressUpsertSQL(
	d1: D1Database,
	userId: string,
	def: MissionDefinition,
	periodKey: string,
	amount: number,
	metadataJson: string | null,
	nowSeconds: number,
): D1PreparedStatement {
	const target = def.target;
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

/**
 * Build the mission_progress UPSERT for the `gamesTried` metric, which uses
 * per-game dedup rows in `mission_game_tried`. Progress is computed as
 * `COUNT(*)` from the dedup table at SQL time, so concurrent requests for
 * different game types both contribute their row and the count reflects all
 * committed rows. Must be preceded by an `INSERT OR IGNORE` into
 * `mission_game_tried` in the same batch so the COUNT sees the new row.
 */
export function buildGamesTriedUpsertSQL(
	d1: D1Database,
	userId: string,
	def: MissionDefinition,
	periodKey: string,
	metadataJson: string | null,
	nowSeconds: number,
): D1PreparedStatement {
	const target = def.target;
	return d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 VALUES (?, ?, ?,
			   (SELECT COUNT(*) FROM mission_game_tried WHERE userId = ? AND missionDefId = ? AND periodKey = ?),
			   ?,
			   CASE WHEN (SELECT COUNT(*) FROM mission_game_tried WHERE userId = ? AND missionDefId = ? AND periodKey = ?) >= ${target} THEN ${nowSeconds} ELSE NULL END,
			   NULL)
			 ON CONFLICT(userId, missionDefId, periodKey) DO UPDATE SET
			   progress = (SELECT COUNT(*) FROM mission_game_tried WHERE userId = mission_progress.userId AND missionDefId = mission_progress.missionDefId AND periodKey = mission_progress.periodKey),
			   metadataJson = excluded.metadataJson,
			   completedAt = CASE
			     WHEN (SELECT COUNT(*) FROM mission_game_tried WHERE userId = mission_progress.userId AND missionDefId = mission_progress.missionDefId AND periodKey = mission_progress.periodKey) >= ${target} AND mission_progress.completedAt IS NULL
			     THEN ${nowSeconds}
			     ELSE mission_progress.completedAt
			   END`,
		)
		.bind(
			userId,
			def.id,
			periodKey,
			userId,
			def.id,
			periodKey,
			metadataJson,
			userId,
			def.id,
			periodKey,
		);
}
