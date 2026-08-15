import type { SettleRoundCommand } from '../wallet';
import type { SicBoRoundResult } from './types';

/**
 * Build a wallet settlement command for one completed Sic Bo round.
 */
export function buildSicBoSettlementCommand(
	settlementId: string,
	result: Pick<SicBoRoundResult, 'netDelta'>,
): SettleRoundCommand {
	return {
		settlementId,
		game: 'sic-bo',
		delta: result.netDelta,
		stats: {
			rounds: 1,
			wins: result.netDelta > 0 ? 1 : 0,
			losses: result.netDelta < 0 ? 1 : 0,
			biggestWin: Math.max(result.netDelta, 0),
		},
	};
}
