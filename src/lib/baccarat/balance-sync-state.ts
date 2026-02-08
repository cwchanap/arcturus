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

export function createPendingStats(): BaccaratPendingStats {
	return {
		winsIncrement: 0,
		lossesIncrement: 0,
		handsIncrement: 0,
		biggestWinCandidate: undefined,
	};
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

export function resolveBaccaratSyncState({
	_error,
	hasServerBalance,
}: {
	_error?: string;
	hasServerBalance: boolean;
}): BaccaratPendingStatsResolution {
	if (hasServerBalance) {
		return { clearPendingStats: true, syncPending: false };
	}

	return { clearPendingStats: false, syncPending: true };
}
