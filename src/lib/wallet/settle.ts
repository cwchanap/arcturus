import type { D1Database } from '@cloudflare/workers-types';
import { checkAndGrantAchievements } from '../achievements/achievements';
import { isValidGameType } from '../game-stats/constants';
import { createDb } from '../db';
import { SETTLEMENT_ID_RE } from './settlement-id';
import { applyWalletSettlementBatch, findWalletSettlement, readWalletBalance } from './repository';
import type { SettleRoundCommand, SettleRoundResult } from './types';

export const MAX_ABSOLUTE_SETTLEMENT_DELTA = 1_000_000;
export const MAX_ABSOLUTE_SETTLEMENT_STAT = 1_000_000;

export type WalletSettlementErrorCode =
	| 'INVALID_COMMAND'
	| 'USER_NOT_FOUND'
	| 'INSUFFICIENT_BALANCE'
	| 'SETTLEMENT_CONFLICT';

export class WalletSettlementDomainError extends Error {
	readonly code: WalletSettlementErrorCode;

	constructor(code: WalletSettlementErrorCode) {
		super(code);
		this.name = 'WalletSettlementDomainError';
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function invalidCommand(): never {
	throw new WalletSettlementDomainError('INVALID_COMMAND');
}

function requireSafeInteger(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalidCommand();
	return value;
}

/**
 * Validate an untrusted settlement payload before it reaches the repository.
 * The route receives JSON, so this deliberately accepts `unknown` even though
 * callers inside the game code use the typed command interface.
 */
export function validate(command: unknown): asserts command is SettleRoundCommand {
	if (!isRecord(command) || !hasOnlyKeys(command, ['settlementId', 'game', 'delta', 'stats'])) {
		return invalidCommand();
	}

	if (
		typeof command.settlementId !== 'string' ||
		!SETTLEMENT_ID_RE.test(command.settlementId) ||
		typeof command.game !== 'string' ||
		!isValidGameType(command.game)
	) {
		return invalidCommand();
	}

	const delta = requireSafeInteger(command.delta);
	if (Math.abs(delta) > MAX_ABSOLUTE_SETTLEMENT_DELTA) return invalidCommand();

	const stats = command.stats;
	if (
		!isRecord(stats) ||
		!hasOnlyKeys(stats, ['rounds', 'wins', 'losses', 'biggestWin', 'netProfit'])
	) {
		return invalidCommand();
	}

	const rounds = requireSafeInteger(stats.rounds);
	const wins = requireSafeInteger(stats.wins);
	const losses = requireSafeInteger(stats.losses);
	const biggestWin = requireSafeInteger(stats.biggestWin);
	const netProfit = stats.netProfit === undefined ? undefined : requireSafeInteger(stats.netProfit);
	if (
		rounds < 1 ||
		wins < 0 ||
		losses < 0 ||
		biggestWin < 0 ||
		!Number.isSafeInteger(wins + losses) ||
		wins + losses > rounds
	) {
		return invalidCommand();
	}

	if (
		rounds > MAX_ABSOLUTE_SETTLEMENT_STAT ||
		wins > MAX_ABSOLUTE_SETTLEMENT_STAT ||
		losses > MAX_ABSOLUTE_SETTLEMENT_STAT ||
		biggestWin > MAX_ABSOLUTE_SETTLEMENT_STAT ||
		(netProfit !== undefined && Math.abs(netProfit) > MAX_ABSOLUTE_SETTLEMENT_STAT)
	) {
		return invalidCommand();
	}
}

export function validateNextBalance(nextBalance: number): void {
	if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) {
		throw new WalletSettlementDomainError(
			nextBalance < 0 ? 'INSUFFICIENT_BALANCE' : 'INVALID_COMMAND',
		);
	}
}

async function buildFreshResult(
	d1: D1Database,
	userId: string,
	command: SettleRoundCommand,
	nextBalance: number,
): Promise<SettleRoundResult> {
	// Achievement evaluation runs AFTER the atomic wallet batch commits.
	// If it throws (transient D1 error), the receipt is already persisted, so a
	// client retry would hit the duplicate path and never re-run achievements.
	// Treat achievement evaluation as best-effort: log the failure and still
	// return the successful settlement. Achievements are re-evaluated naturally
	// on the user's next completed round because checkAndGrantAchievements
	// reads current state each time.
	let newAchievements: Array<{ id: string; name: string; icon: string }> = [];
	try {
		const earned = await checkAndGrantAchievements(createDb(d1), userId, nextBalance, {
			recentWinAmount: command.stats.biggestWin > 0 ? command.stats.biggestWin : undefined,
			gameType: command.game,
		});
		newAchievements = earned.map((achievement) => ({
			id: achievement.id,
			name: achievement.name,
			icon: achievement.icon,
		}));
	} catch (error) {
		console.error('[WALLET_SETTLEMENT] Achievement evaluation failed (best-effort):', error);
	}

	return {
		balance: nextBalance,
		duplicate: false,
		...(newAchievements.length > 0 ? { newAchievements } : {}),
	};
}

export async function settleWalletRound(
	d1: D1Database,
	userId: string,
	command: SettleRoundCommand,
	requiredFunds?: number,
): Promise<SettleRoundResult> {
	validate(command);

	if (requiredFunds !== undefined && (!Number.isSafeInteger(requiredFunds) || requiredFunds < 0)) {
		throw new WalletSettlementDomainError('INVALID_COMMAND');
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const receipt = await findWalletSettlement(d1, userId, command.settlementId);
		if (receipt) return { balance: receipt.balance, duplicate: true };

		const balance = await readWalletBalance(d1, userId);
		if (balance === null) throw new WalletSettlementDomainError('USER_NOT_FOUND');

		if (requiredFunds !== undefined && balance < requiredFunds) {
			throw new WalletSettlementDomainError('INSUFFICIENT_BALANCE');
		}

		const nextBalance = balance + command.delta;
		validateNextBalance(nextBalance);

		const attemptId = crypto.randomUUID();
		const applied = await applyWalletSettlementBatch(d1, {
			userId,
			attemptId,
			expectedBalance: balance,
			nextBalance,
			command,
			nowSeconds: Math.trunc(Date.now() / 1000),
		});

		if (applied) return buildFreshResult(d1, userId, command, nextBalance);

		const racedReceipt = await findWalletSettlement(d1, userId, command.settlementId);
		if (racedReceipt) return { balance: racedReceipt.balance, duplicate: true };
	}

	throw new WalletSettlementDomainError('SETTLEMENT_CONFLICT');
}
