import {
	MAX_CRAPS_SYNC_HANDS_PER_REQUEST,
	MAX_CRAPS_SYNC_LOSS_DELTA,
	MAX_CRAPS_SYNC_WIN_DELTA,
} from './syncLimits';

export type PendingRollSync = {
	netDelta: number;
	winsCount: number;
	lossesCount: number;
	pushesCount: number;
	// Gross winnings from all winning bets on this roll, before subtracting losses.
	// Needed to record biggest-win stats correctly on mixed-outcome rolls where a
	// legitimate winning wager is hidden by a larger loss on the same roll (e.g. a
	// small prop win offset by a place-bet loss on a 7-out).
	grossWinAmount?: number;
};

export {
	MAX_CRAPS_SYNC_HANDS_PER_REQUEST,
	MAX_CRAPS_SYNC_LOSS_DELTA,
	MAX_CRAPS_SYNC_WIN_DELTA,
} from './syncLimits';

export type CrapsSyncBatch = {
	ackRollSyncs: PendingRollSync[];
	ackHands: number;
	ackWins: number;
	ackLosses: number;
	ackStatsDelta: number;
	ackBiggestWin: number | undefined;
	ackDelta: number;
	pendingWagerDelta: number;
	pendingBalanceDelta: number;
	totalPendingRollDelta: number;
	remainingRollDelta: number;
};

export function buildCrapsSyncBatch({
	pendingRollSyncs,
	currentBalance,
	previousBalance,
	maxSyncHandsPerRequest = MAX_CRAPS_SYNC_HANDS_PER_REQUEST,
	maxWinDelta = MAX_CRAPS_SYNC_WIN_DELTA,
	maxLossDelta = MAX_CRAPS_SYNC_LOSS_DELTA,
}: {
	pendingRollSyncs: PendingRollSync[];
	currentBalance: number;
	previousBalance: number;
	maxSyncHandsPerRequest?: number;
	maxWinDelta?: number;
	maxLossDelta?: number;
}): CrapsSyncBatch {
	const totalPendingRollDelta = pendingRollSyncs.reduce((sum, entry) => sum + entry.netDelta, 0);
	const pendingBalanceDelta = currentBalance - previousBalance;
	const pendingWagerDelta = pendingBalanceDelta - totalPendingRollDelta;

	const ackRollSyncs: PendingRollSync[] = [];
	let ackWins = 0;
	let ackLosses = 0;
	let ackStatsDelta = 0;
	let ackBiggestWin: number | undefined;

	for (const entry of pendingRollSyncs) {
		if (ackRollSyncs.length >= maxSyncHandsPerRequest) {
			break;
		}

		const nextStatsDelta = ackStatsDelta + entry.netDelta;
		const projectedDelta = pendingWagerDelta + nextStatsDelta;
		if (
			projectedDelta > maxWinDelta ||
			projectedDelta < -maxLossDelta ||
			nextStatsDelta > maxWinDelta ||
			nextStatsDelta < -maxLossDelta
		) {
			// If the roll itself fits within the cap it is safe to defer: after the wager-only
			// delta is flushed the next sync will have pendingWagerDelta≈0, so the combined
			// value will then be small enough to include.
			//
			// If however the roll alone already exceeds the cap, deferring it is useless — the
			// next call will still fail the check and the roll will be permanently stranded.
			// Force-include the first such entry so it is at least attempted; the server's own
			// GAME_LIMITS check is the final authority on whether the value is acceptable.
			const rollAloneExceedsCap = entry.netDelta > maxWinDelta || entry.netDelta < -maxLossDelta;
			if (ackRollSyncs.length > 0 || !rollAloneExceedsCap) {
				break;
			}
		}

		ackRollSyncs.push(entry);
		ackStatsDelta = nextStatsDelta;
		// Classify roll outcome: count as win if either net positive OR had gross winnings.
		// This ensures mixed-outcome rolls (e.g., prop win offset by larger loss) still
		// record wins for biggest-win stats tracking.
		const hasWin = entry.netDelta > 0 || (entry.grossWinAmount ?? 0) > 0;
		if (hasWin) {
			ackWins += 1;
		} else if (entry.netDelta < 0) {
			ackLosses += 1;
		}
		// Prefer grossWinAmount so that a legitimate win on a mixed-outcome roll
		// (e.g. prop win offset by a larger place-bet loss) is still considered.
		const rollWinAmount =
			typeof entry.grossWinAmount === 'number' && entry.grossWinAmount > 0
				? entry.grossWinAmount
				: entry.netDelta > 0
					? entry.netDelta
					: 0;
		if (rollWinAmount > 0) {
			ackBiggestWin =
				ackBiggestWin === undefined ? rollWinAmount : Math.max(ackBiggestWin, rollWinAmount);
		}
	}

	return {
		ackRollSyncs,
		ackHands: ackRollSyncs.length,
		ackWins,
		ackLosses,
		ackStatsDelta,
		ackBiggestWin,
		ackDelta: pendingWagerDelta + ackStatsDelta,
		pendingWagerDelta,
		pendingBalanceDelta,
		totalPendingRollDelta,
		remainingRollDelta: totalPendingRollDelta - ackStatsDelta,
	};
}

export function getBalanceAfterCrapsSyncSuccess({
	serverBalance,
	ackCurrentBalance,
	currentBalance,
	remainingRollDelta,
}: {
	serverBalance: number;
	ackCurrentBalance: number;
	currentBalance: number;
	remainingRollDelta: number;
}): number {
	const concurrentLocalDelta = currentBalance - ackCurrentBalance;
	return serverBalance + remainingRollDelta + concurrentLocalDelta;
}

export function getBalanceAfterCrapsSyncFailure({
	serverBalance,
	ackCurrentBalance,
	currentBalance,
	pendingBalanceDelta,
}: {
	serverBalance: number;
	ackCurrentBalance: number;
	currentBalance: number;
	pendingBalanceDelta: number;
}): number {
	const concurrentLocalDelta = currentBalance - ackCurrentBalance;
	return serverBalance + pendingBalanceDelta + concurrentLocalDelta;
}
