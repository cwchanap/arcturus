export type BaccaratPendingStats = {
	winsIncrement: number;
	lossesIncrement: number;
	handsIncrement: number;
	biggestWinCandidate: number | undefined;
};

export type BaccaratPendingStatsResolution = {
	clearPendingStats: boolean;
	syncPending: boolean;
};

export const MAX_FOLLOW_UP_ATTEMPTS = 3;
const MAX_FOLLOW_UP_BACKOFF_MS = 8000;

export function createPendingStats(): BaccaratPendingStats {
	return {
		winsIncrement: 0,
		lossesIncrement: 0,
		handsIncrement: 0,
		biggestWinCandidate: undefined,
	};
}

export function shouldAbandonFollowUpSync(
	followUpSyncAttempts: number,
	maxFollowUpAttempts: number = MAX_FOLLOW_UP_ATTEMPTS,
): boolean {
	return followUpSyncAttempts >= maxFollowUpAttempts;
}

export function getFollowUpBackoffDelayMs(followUpAttemptNumber: number): number {
	if (!Number.isFinite(followUpAttemptNumber) || followUpAttemptNumber <= 0) {
		return 1000;
	}
	return Math.min(1000 * Math.pow(2, followUpAttemptNumber - 1), MAX_FOLLOW_UP_BACKOFF_MS);
}

export function addPendingStats(
	pendingStats: BaccaratPendingStats,
	winsIncrement: number,
	lossesIncrement: number,
	handsIncrement: number,
	roundDelta: number,
): BaccaratPendingStats {
	const newBiggestWin = roundDelta > 0 ? roundDelta : undefined;
	return {
		winsIncrement: pendingStats.winsIncrement + winsIncrement,
		lossesIncrement: pendingStats.lossesIncrement + lossesIncrement,
		handsIncrement: pendingStats.handsIncrement + handsIncrement,
		biggestWinCandidate:
			newBiggestWin !== undefined
				? Math.max(pendingStats.biggestWinCandidate ?? 0, newBiggestWin)
				: pendingStats.biggestWinCandidate,
	};
}

export function reconcilePendingBiggestWinCandidate(
	currentBiggestWinCandidate: number | undefined,
	snapshotBiggestWinCandidate: number | undefined,
): number | undefined {
	const current = currentBiggestWinCandidate ?? 0;
	const snapshot = snapshotBiggestWinCandidate ?? 0;
	return current > snapshot ? current : undefined;
}

const NON_RETRIABLE_ERRORS = [
	'DELTA_EXCEEDS_LIMIT',
	'INSUFFICIENT_BALANCE',
	'BALANCE_MISMATCH',
	'INVALID_REQUEST',
];

export function resolveBaccaratSyncState({
	error,
	hasServerBalance,
}: {
	error?: string;
	hasServerBalance: boolean;
}): BaccaratPendingStatsResolution {
	if (hasServerBalance) {
		return { clearPendingStats: true, syncPending: false };
	}

	// Terminal errors should not trigger auto-retry
	if (error && NON_RETRIABLE_ERRORS.includes(error)) {
		return { clearPendingStats: false, syncPending: false };
	}

	return { clearPendingStats: false, syncPending: true };
}
