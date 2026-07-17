/**
 * Pure error-classification helpers for the roulette spin client.
 *
 * Extracted from rouletteClient.ts so these chip-safety-critical functions
 * can be unit-tested with a status×code matrix without DOM dependencies.
 *
 * These functions decide whether a failed spin should be:
 *   - Retried (server may have committed — same syncId returns stored result)
 *   - Discarded with bets restored (server definitively rejected — no commit)
 *   - Treated as ambiguous (balance recovery / refresh needed)
 */

// Preserves the HTTP status (+ error code) from a non-ok spin response so
// retry logic can decide retriability by status/code rather than fragile
// message-prefix matching. `currentBalance` carries the server-provided
// authoritative balance from INSUFFICIENT_BALANCE responses so the client
// can adopt it instead of keeping a stale local balance.
export class SpinHttpError extends Error {
	readonly status: number;
	readonly currentBalance?: number;
	constructor(status: number, error: string, currentBalance?: number) {
		super(error);
		this.name = 'SpinHttpError';
		this.status = status;
		this.currentBalance = currentBalance;
	}
}

// A spin attempt is retriable when the server may have committed the
// round but we didn't receive the result. Only 409 CONCURRENT_MODIFICATION
// is retriable among 409s — retrying with the same syncId returns the
// stored result via idempotency. Other 409s (MP_ESCROW_ACTIVE,
// SYNC_ID_REUSE_MISMATCH) can never succeed on retry. 5xx means the
// server errored mid-processing — retrying is safe for the same reason.
// TypeError means the network failed before a response arrived.
// AbortError means the fetch timed out (fetchWithTimeout) — the server
// may have processed the spin even though we never got the response.
export function isRetriableSpinError(err: unknown): boolean {
	if (err instanceof TypeError) return true;
	if (err instanceof DOMException && err.name === 'AbortError') return true;
	if (err instanceof SpinHttpError) {
		if (err.status >= 500) return true;
		if (err.status === 409) return err.message === 'CONCURRENT_MODIFICATION';
		return false;
	}
	return false;
}

// Definitive client rejections: the server did not commit the spin.
// Restore betting with bets intact instead of discarding or retrying.
// Only known pre-commit 409 error codes are classified as rejections;
// an unknown 409 message is treated as ambiguous (may have committed)
// so the caller falls through to retry / balance recovery instead of
// discarding bets.
const NON_COMMITTED_409_CODES = new Set(['MP_ESCROW_ACTIVE', 'SYNC_ID_REUSE_MISMATCH']);

export function isNonCommittedSpinRejection(err: unknown): err is SpinHttpError {
	if (!(err instanceof SpinHttpError)) return false;
	if (err.status === 429) return true;
	if (err.status === 400 || err.status === 401 || err.status === 403) return true;
	// Non-retriable 409s: escrow lock, syncId reuse with different bets.
	// Unknown 409 codes are NOT classified — they may have committed.
	if (err.status === 409 && NON_COMMITTED_409_CODES.has(err.message)) return true;
	return false;
}

export function messageForSpinRejection(err: SpinHttpError): string {
	switch (err.message) {
		case 'MP_ESCROW_ACTIVE':
			return 'Chips locked in multiplayer poker — finish or leave the table first.';
		case 'RATE_LIMITED':
			return 'Please wait a moment before spinning again.';
		case 'INSUFFICIENT_BALANCE':
			return 'Insufficient chips for this spin.';
		case 'SYNC_ID_REUSE_MISMATCH':
			return 'Spin conflict — adjust bets and try again.';
		default:
			return err.message.startsWith('HTTP ')
				? 'Spin rejected — please try again.'
				: `Spin rejected: ${err.message}`;
	}
}
