export type PendingRollSync = {
	netDelta: number;
	winsCount: number;
	lossesCount: number;
	pushesCount: number;
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
	let ackPushes = 0;
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
		ackWins += entry.winsCount;
		ackLosses += entry.lossesCount;
		ackPushes += entry.pushesCount;
		if (entry.netDelta > 0) {
			ackBiggestWin =
				ackBiggestWin === undefined ? entry.netDelta : Math.max(ackBiggestWin, entry.netDelta);
		}
	}

	return {
		ackRollSyncs,
		ackHands: ackWins + ackLosses + ackPushes,
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
