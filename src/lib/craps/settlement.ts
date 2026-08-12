import type { RollResult } from './types';
import type { SettleRoundCommand } from '../wallet';

export function buildCrapsSettlementCommand(
	settlementId: string,
	result: RollResult,
): SettleRoundCommand | null {
	const resolved = result.evaluations.filter(
		(evaluation) =>
			evaluation.outcome === 'win' ||
			evaluation.outcome === 'lose' ||
			evaluation.outcome === 'push',
	);
	if (resolved.length === 0) return null;

	return {
		settlementId,
		game: 'craps',
		delta: result.netDelta,
		stats: {
			rounds: resolved.length,
			wins: resolved.filter((evaluation) => evaluation.outcome === 'win').length,
			losses: resolved.filter((evaluation) => evaluation.outcome === 'lose').length,
			biggestWin: Math.max(result.netDelta, 0),
		},
	};
}

export function getAvailableCrapsBalance(walletBalance: number, activeAtRisk: number): number {
	if (!Number.isSafeInteger(walletBalance) || walletBalance < 0) {
		throw new Error('Invalid wallet balance');
	}
	if (!Number.isSafeInteger(activeAtRisk) || activeAtRisk < 0) {
		throw new Error('Invalid active at-risk amount');
	}
	if (activeAtRisk > walletBalance) {
		throw new Error('Active Craps wagers exceed the settled wallet balance');
	}
	return walletBalance - activeAtRisk;
}
