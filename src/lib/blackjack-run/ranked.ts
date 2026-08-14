import type { SettleRoundCommand } from '../wallet/types';
import type { BlackjackRoundOutcome, BlackjackRoundState } from './engine';
import type { BlackjackAction } from './protocol';

// Ranked wager constants (the engine enforces the same bounds on replay).
export { MAXIMUM_WAGER, MINIMUM_WAGER } from './engine';

/** A Ranked run stays open for 15 minutes; after that every committed hand loses. */
export const RANKED_RUN_TTL_SECONDS = 15 * 60;

/** Additional stake a command commits on top of the run's initial wager. */
export function additionalWagerFor(action: BlackjackAction, wager: number): number {
	return action === 'double-down' || action === 'split' ? wager : 0;
}

/** Terminal outcome for an expired Ranked run: every committed hand loses. */
export function buildExpiryOutcome(state: BlackjackRoundState): BlackjackRoundOutcome {
	const wagers =
		state.playerHands.length > 0
			? state.playerHands.map(({ wager }) => wager)
			: [state.committedWager];
	return {
		result: 'loss',
		hands: wagers.map((wager, handIndex) => ({
			handIndex,
			result: 'loss',
			wager,
			payout: 0,
		})),
		committedWager: state.committedWager,
		payout: 0,
		gameNetDelta: -state.committedWager,
	};
}

/**
 * Builds the stable terminal wallet settlement for a Ranked run. Ranked stakes
 * are debited atomically during the run, so the wallet only credits the gross
 * payout while `stats.netProfit` records the true game net delta.
 */
export function buildRankedSettlementCommand(
	runId: string,
	outcome: BlackjackRoundOutcome,
): SettleRoundCommand {
	return {
		settlementId: `blackjack-run-${runId}`,
		game: 'blackjack',
		delta: outcome.payout,
		stats: {
			rounds: 1,
			wins: outcome.result === 'win' ? 1 : 0,
			losses: outcome.result === 'loss' ? 1 : 0,
			biggestWin: Math.max(0, outcome.gameNetDelta),
			netProfit: outcome.gameNetDelta,
		},
	};
}
