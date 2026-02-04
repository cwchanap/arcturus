export type BaccaratPendingStatsResolution = {
	clearPendingStats: boolean;
	syncPending: boolean;
};

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

	if (error === 'RATE_LIMITED') {
		return { clearPendingStats: false, syncPending: true };
	}

	return { clearPendingStats: false, syncPending: true };
}
