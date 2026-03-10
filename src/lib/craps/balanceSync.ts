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

// Keep these limits aligned with GAME_LIMITS.craps in src/pages/api/chips/update.ts.
export const MAX_CRAPS_SYNC_HANDS_PER_REQUEST = 100;
export const MAX_CRAPS_SYNC_WIN_DELTA = 50000;
export const MAX_CRAPS_SYNC_LOSS_DELTA = 100000;

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
		if (projectedDelta > maxWinDelta || projectedDelta < -maxLossDelta) {
			break;
		}

		ackRollSyncs.push(entry);
		ackStatsDelta = nextStatsDelta;
		if (entry.netDelta > 0) {
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
