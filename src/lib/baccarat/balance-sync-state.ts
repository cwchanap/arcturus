export type BaccaratPendingStatsResolution = {
	clearPendingStats: boolean;
	syncPending: boolean;
};

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
