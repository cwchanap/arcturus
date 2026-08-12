import type { SettleRoundCommand } from '../wallet';

export function buildBaccaratSettlementCommand(
	settlementId: string,
	roundNetDelta: number,
): SettleRoundCommand {
	return {
		settlementId,
		game: 'baccarat',
		delta: roundNetDelta,
		stats: {
			rounds: 1,
			wins: roundNetDelta > 0 ? 1 : 0,
			losses: roundNetDelta < 0 ? 1 : 0,
			biggestWin: Math.max(0, roundNetDelta),
		},
	};
}
