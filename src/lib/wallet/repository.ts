import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { prepareMissionProgressStatements } from '../missions/progress';
import type { SettleRoundCommand, WalletSettlementGate } from './types';

export interface WalletSettlementReceipt {
	balance: number;
	attemptId: string;
}

export interface ApplyWalletSettlementBatchParams {
	userId: string;
	attemptId: string;
	expectedBalance: number;
	nextBalance: number;
	command: SettleRoundCommand;
	nowSeconds: number;
}

type RowsAffectedResult = { meta?: { changes?: number }; rowsAffected?: number } | null | undefined;

/**
 * D1 returns the affected-row count in `meta.changes`, while the SQLite
 * adapters used by tests may expose `rowsAffected` instead. Keep the
 * compatibility normalization at the wallet boundary so callers can only
 * reason about whether the guarded update won.
 */
export function getRowsAffected(result: RowsAffectedResult): number {
	return result?.meta?.changes ?? result?.rowsAffected ?? 0;
}

export async function findWalletSettlement(
	d1: D1Database,
	userId: string,
	settlementId: string,
): Promise<WalletSettlementReceipt | null> {
	const row = await d1
		.prepare(
			'SELECT balance, attemptId FROM wallet_settlement WHERE userId = ? AND settlementId = ? LIMIT 1',
		)
		.bind(userId, settlementId)
		.first<WalletSettlementReceipt>();

	return row ? { balance: row.balance, attemptId: row.attemptId } : null;
}

export async function readWalletBalance(d1: D1Database, userId: string): Promise<number | null> {
	const row = await d1
		.prepare('SELECT chipBalance FROM user WHERE id = ? LIMIT 1')
		.bind(userId)
		.first<{ chipBalance: number }>();
	return row?.chipBalance ?? null;
}

const WALLET_STATS_UPSERT_SQL = `INSERT INTO game_stats
	(userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt)
	SELECT ?, ?, ?, ?, ?, ?, ?, ?
	WHERE EXISTS (
		SELECT 1 FROM wallet_settlement
		WHERE userId = ? AND settlementId = ? AND attemptId = ?
	)
	ON CONFLICT(userId, gameType) DO UPDATE SET
		totalWins = game_stats.totalWins + excluded.totalWins,
		totalLosses = game_stats.totalLosses + excluded.totalLosses,
		handsPlayed = game_stats.handsPlayed + excluded.handsPlayed,
		biggestWin = CASE
			WHEN excluded.biggestWin > 0 AND excluded.biggestWin > game_stats.biggestWin
				THEN excluded.biggestWin
			ELSE game_stats.biggestWin
		END,
		netProfit = game_stats.netProfit + excluded.netProfit,
		updatedAt = excluded.updatedAt`;

/**
 * Apply the guarded balance update, receipt tombstone, statistics upsert, and
 * mission writes in one D1 transaction. The receipt's `(userId,
 * settlementId)` key protects idempotency, while its server-only `attemptId`
 * gates stats and missions to the fresh winning request.
 */
export async function applyWalletSettlementBatch(
	d1: D1Database,
	params: ApplyWalletSettlementBatchParams,
): Promise<boolean> {
	const { command, userId, attemptId, expectedBalance, nextBalance, nowSeconds } = params;
	// Ranked runs debit stakes during the run, so the wallet delta is only the
	// gross payout to credit back; the true game net result (payout minus
	// committed stakes) arrives via stats.netProfit. Non-ranked callers omit
	// it and keep the legacy semantics: delta IS the net profit.
	const netProfit = command.stats.netProfit ?? command.delta;
	const missionEvent = {
		gameType: command.game,
		outcome:
			command.stats.wins > 0
				? ('win' as const)
				: command.stats.losses > 0
					? ('loss' as const)
					: netProfit > 0
						? ('win' as const)
						: netProfit < 0
							? ('loss' as const)
							: ('push' as const),
		handCount: command.stats.rounds,
		winsIncrement: command.stats.wins,
		lossesIncrement: command.stats.losses,
		delta: netProfit,
	};
	const gate: WalletSettlementGate = {
		settlementId: command.settlementId,
		attemptId,
	};
	const missionStatements = await prepareMissionProgressStatements(
		d1,
		[{ userId, event: missionEvent }],
		new Map<string, WalletSettlementGate>([[userId, gate]]),
	);

	const statements: D1PreparedStatement[] = [
		d1
			.prepare(
				`UPDATE user
				 SET chipBalance = ?, updatedAt = ?
				 WHERE id = ?
				   AND chipBalance = ?
				   AND NOT EXISTS (
					 SELECT 1 FROM wallet_settlement
					 WHERE userId = ? AND settlementId = ?
				   )`,
			)
			.bind(nextBalance, nowSeconds, userId, expectedBalance, userId, command.settlementId),
		d1
			.prepare(
				'INSERT INTO wallet_settlement (userId, settlementId, attemptId, balance, createdAt) SELECT ?, ?, ?, ?, ? WHERE changes() = 1',
			)
			.bind(userId, command.settlementId, attemptId, nextBalance, nowSeconds),
		d1
			.prepare(WALLET_STATS_UPSERT_SQL)
			.bind(
				userId,
				command.game,
				command.stats.wins,
				command.stats.losses,
				command.stats.rounds,
				Math.max(command.stats.biggestWin, 0),
				netProfit,
				nowSeconds,
				userId,
				command.settlementId,
				attemptId,
			),
		...missionStatements,
	];

	const results = await d1.batch(statements);
	return getRowsAffected(results[0] as RowsAffectedResult) > 0;
}
