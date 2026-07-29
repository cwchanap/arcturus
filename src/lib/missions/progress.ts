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
 *
 * Durability: this function runs the mission writes in its OWN `d1.batch`,
 * separate from any chip-sync receipt. That means a transient failure here
 * is NOT retried on syncId replay (the receipt already exists, so the chip
 * path returns early without re-running progress). Callers that need
 * mission progress atomically tied to a chip_sync_receipt MUST instead use
 * {@link prepareMissionProgressStatements} with a `gateMap` and merge the
 * returned statements into the same `d1.batch` as the receipt INSERT.
 */
export async function applyMissionProgressBatch(
	d1: D1Database,
	entries: { userId: string; event: MissionGameEvent }[],
): Promise<void> {
	const statements = await prepareMissionProgressStatements(d1, entries);
	if (statements.length > 0) {
		await d1.batch(statements);
	}
}

/**
 * Read phase context for one user: the active mission set (after applying
 * reroll overrides) and the existing progress rows for those missions.
 */
interface MissionProgressContext {
	userId: string;
	allActive: MissionDefinition[];
	progressMap: Map<string, { progress: number; metadataJson: string | null }>;
}

/**
 * Read the per-user mission progress context (overrides + active defs +
 * existing progress rows) for a set of entries. The progress defIds depend
 * on each user's overrides (rerolled missions swap in a replacement id),
 * so these reads can't be merged into one statement — but they run
 * concurrently via `Promise.all`.
 */
async function readMissionProgressContext(
	d1: D1Database,
	valid: { userId: string; event: MissionGameEvent }[],
): Promise<MissionProgressContext[]> {
	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();
	return Promise.all(
		valid.map(async ({ userId }) => {
			const overrides = await getOverrides(d1, userId, dailyKey);
			const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
			const allActive = [...activeDaily, ...DEFAULT_WEEKLY_MISSIONS];
			const activeDefIds = allActive.map((d) => d.id);
			const progressMap = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);
			return { userId, allActive, progressMap };
		}),
	);
}

/**
 * Build the mission_progress upsert statements for a set of entries, ready
 * to submit via `d1.batch`.
 *
 * When `gateMap` is provided, every statement is gated on
 * `EXISTS (SELECT 1 FROM chip_sync_receipt WHERE userId = ? AND syncId = ?)`
 * so it is a no-op unless the receipt for that user+syncId has already been
 * inserted earlier in the same D1 batch transaction. This durably couples
 * mission progress to the idempotent chip event: if the chip-sync receipt
 * INSERT is skipped (optimistic-lock miss) the mission writes skip too, and
 * if the whole batch commits the mission writes commit with it — no
 * separate deferred write that can be silently dropped and never retried.
 *
 * Callers that merge these statements into their own batch MUST place them
 * AFTER the `chip_sync_receipt` INSERT for the corresponding user, so the
 * EXISTS subquery sees the receipt row within the same transaction.
 */
export async function prepareMissionProgressStatements(
	d1: D1Database,
	entries: { userId: string; event: MissionGameEvent }[],
	gateMap?: Map<string, string>,
): Promise<D1PreparedStatement[]> {
	const valid = entries.filter((e) => e.event.outcome);
	if (valid.length === 0) return [];

	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();
	const nowSeconds = Math.trunc(Date.now() / 1000);

	const readResults = await readMissionProgressContext(d1, valid);

	const statements: D1PreparedStatement[] = [];
	for (let i = 0; i < valid.length; i++) {
		const { event } = valid[i]!;
		const { userId, allActive, progressMap } = readResults[i]!;
		// When a gateMap is provided, look up the syncId for this user. If
		// the user is missing from the map, skip gating (treat as ungated)
		// rather than crashing — the caller is responsible for populating
		// the map for every entry that needs durable coupling.
		const gateSyncId = gateMap?.get(userId);
		const gate = gateSyncId !== undefined ? { syncId: gateSyncId } : undefined;
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
				const dedupStmt = buildGamesTriedDedupStmt(
					d1,
					userId,
					def.id,
					periodKey,
					event.gameType,
					nowSeconds,
					gate,
				);
				const progressStmt = buildGamesTriedUpsertSQL(
					d1,
					userId,
					def,
					periodKey,
					metadataJson,
					nowSeconds,
					gate,
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
					gate,
				);
				statements.push(stmt);
			}
		}
	}

	return statements;
}

/**
 * Optional receipt-existence gate for mission progress statements. When
 * provided, the INSERT is converted from `VALUES (...)` to
 * `SELECT ... WHERE EXISTS (SELECT 1 FROM chip_sync_receipt ...)` so the
 * statement is a no-op unless the receipt row has been inserted earlier in
 * the same D1 batch transaction. This durably couples mission progress to
 * the idempotent chip event and closes the "deferred mission write fails,
 * retry returns cached receipt success, progress permanently lost" gap.
 */
interface ReceiptGate {
	syncId: string;
}

/**
 * SQL fragment appended to gated INSERTs. Uses `EXISTS` against
 * `chip_sync_receipt` rather than `changes()` so the gate is robust to
 * statement ordering within the batch — it does not depend on the
 * immediately preceding statement having modified a row.
 */
const RECEIPT_GATE_SQL =
	' WHERE EXISTS (SELECT 1 FROM chip_sync_receipt WHERE userId = ? AND syncId = ?)';

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
	gate?: ReceiptGate,
): D1PreparedStatement {
	const target = def.target;
	const clampedAmount = Math.min(amount, target);
	const completedClause = clampedAmount >= target ? `${nowSeconds}` : 'NULL';
	// When gated, convert `VALUES (...)` to `SELECT ... WHERE EXISTS(...)` so
	// the INSERT is a no-op unless the chip_sync_receipt row for this user+
	// syncId has been inserted earlier in the same D1 batch transaction.
	const rowSource = gate
		? `SELECT ?, ?, ?, ?, ?, ${completedClause}, NULL${RECEIPT_GATE_SQL}`
		: `VALUES (?, ?, ?, ?, ?, ${completedClause}, NULL)`;
	const binds = gate
		? [userId, def.id, periodKey, clampedAmount, metadataJson, userId, gate.syncId]
		: [userId, def.id, periodKey, clampedAmount, metadataJson];
	return d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 ${rowSource}
			 ON CONFLICT (userId, missionDefId, periodKey) DO UPDATE SET
			   progress = MIN(mission_progress.progress + excluded.progress, ${target}),
			   metadataJson = excluded.metadataJson,
			   completedAt = CASE
			     WHEN MIN(mission_progress.progress + excluded.progress, ${target}) >= ${target} AND mission_progress.completedAt IS NULL
			     THEN ${nowSeconds}
			     ELSE mission_progress.completedAt
			   END`,
		)
		.bind(...binds);
}

/**
 * Build the `INSERT OR IGNORE` dedup row for the `gamesTried` metric. When
 * gated, the INSERT is a no-op unless the chip_sync_receipt row exists (same
 * transaction). Must precede the corresponding {@link buildGamesTriedUpsertSQL}
 * progress statement in the same batch so the COUNT(*) sees the new row.
 */
export function buildGamesTriedDedupStmt(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	periodKey: string,
	gameType: string,
	nowSeconds: number,
	gate?: ReceiptGate,
): D1PreparedStatement {
	const rowSource = gate ? `SELECT ?, ?, ?, ?, ?${RECEIPT_GATE_SQL}` : `VALUES (?, ?, ?, ?, ?)`;
	const binds = gate
		? [userId, missionDefId, periodKey, gameType, nowSeconds, userId, gate.syncId]
		: [userId, missionDefId, periodKey, gameType, nowSeconds];
	return d1
		.prepare(
			`INSERT OR IGNORE INTO mission_game_tried (userId, missionDefId, periodKey, gameType, firstTriedAt) ${rowSource}`,
		)
		.bind(...binds);
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
	gate?: ReceiptGate,
): D1PreparedStatement {
	const target = def.target;
	// When gated, append the EXISTS clause to the SELECT row source. The
	// gamesTried upsert already uses SELECT (for the COUNT subqueries), so
	// the gate is appended after the row columns, before ON CONFLICT.
	const gateClause = gate ? RECEIPT_GATE_SQL : '';
	const gateBinds = gate ? [userId, gate.syncId] : [];
	return d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 SELECT ?, ?, ?,
			   (SELECT COUNT(*) FROM mission_game_tried WHERE userId = ? AND missionDefId = ? AND periodKey = ?),
			   ?,
			   CASE WHEN (SELECT COUNT(*) FROM mission_game_tried WHERE userId = ? AND missionDefId = ? AND periodKey = ?) >= ${target} THEN ${nowSeconds} ELSE NULL END,
			   NULL${gateClause}
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
			...gateBinds,
		);
}
