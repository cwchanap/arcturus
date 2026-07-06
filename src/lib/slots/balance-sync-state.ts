export type SlotsPendingStats = {
	winsIncrement: number;
	lossesIncrement: number;
	handsIncrement: number;
	biggestWinCandidate: number | undefined;
};

export type SlotsSyncResolution = {
	clearPendingStats: boolean;
	syncPending: boolean;
};

export const MAX_FOLLOW_UP_ATTEMPTS = 3;
const MAX_FOLLOW_UP_BACKOFF_MS = 8000;

const NON_RETRIABLE_ERRORS = [
	'DELTA_EXCEEDS_LIMIT',
	'INSUFFICIENT_BALANCE',
	'BALANCE_MISMATCH',
	'INVALID_REQUEST',
	'INVALID_GAME_TYPE',
];

export function createPendingStats(): SlotsPendingStats {
	return {
		winsIncrement: 0,
		lossesIncrement: 0,
		handsIncrement: 0,
		biggestWinCandidate: undefined,
	};
}

export function addPendingStats(
	pending: SlotsPendingStats,
	winsIncrement: number,
	lossesIncrement: number,
	handsIncrement: number,
	roundDelta: number,
): SlotsPendingStats {
	const candidate = roundDelta > 0 ? roundDelta : undefined;
	return {
		winsIncrement: pending.winsIncrement + winsIncrement,
		lossesIncrement: pending.lossesIncrement + lossesIncrement,
		handsIncrement: pending.handsIncrement + handsIncrement,
		biggestWinCandidate:
			candidate !== undefined
				? Math.max(pending.biggestWinCandidate ?? 0, candidate)
				: pending.biggestWinCandidate,
	};
}

export function shouldAbandonFollowUpSync(
	attempts: number,
	maxAttempts: number = MAX_FOLLOW_UP_ATTEMPTS,
): boolean {
	return attempts >= maxAttempts;
}

export function getFollowUpBackoffDelayMs(attempt: number): number {
	if (!Number.isFinite(attempt) || attempt <= 0) return 1000;
	return Math.min(1000 * Math.pow(2, attempt - 1), MAX_FOLLOW_UP_BACKOFF_MS);
}

export function resolveSlotsSyncState({
	error,
	hasServerBalance,
}: {
	error?: string;
	hasServerBalance: boolean;
}): SlotsSyncResolution {
	if (hasServerBalance) return { clearPendingStats: true, syncPending: false };
	if (error && NON_RETRIABLE_ERRORS.includes(error)) {
		return { clearPendingStats: true, syncPending: false };
	}
	return { clearPendingStats: false, syncPending: true };
}
