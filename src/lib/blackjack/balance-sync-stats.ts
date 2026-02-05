export type PendingStats = {
	winsIncrement: number;
	lossesIncrement: number;
	handsIncrement: number;
};

export function createPendingStats(): PendingStats {
	return { winsIncrement: 0, lossesIncrement: 0, handsIncrement: 0 };
}

export function addPendingStats(
	pendingStats: PendingStats,
	increment: PendingStats,
): PendingStats {
	return {
		winsIncrement: pendingStats.winsIncrement + increment.winsIncrement,
		lossesIncrement: pendingStats.lossesIncrement + increment.lossesIncrement,
		handsIncrement: pendingStats.handsIncrement + increment.handsIncrement,
	};
}

export function ensureRoundStatsIncluded(
	pendingStats: PendingStats,
	increment: PendingStats,
	statsIncluded: boolean,
): { pendingStats: PendingStats; statsIncluded: boolean } {
	if (statsIncluded) {
		return { pendingStats, statsIncluded };
	}

	return {
		pendingStats: addPendingStats(pendingStats, increment),
		statsIncluded: true,
	};
}

export function clearPendingStats(): PendingStats {
	return createPendingStats();
}

export function markSyncPendingOnRateLimit(_syncPending: boolean): boolean {
	// Always mark sync as pending when rate limit is hit
	return true;
}
