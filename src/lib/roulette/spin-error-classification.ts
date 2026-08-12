/** Preserve the HTTP status and server error code for current-page handling. */
export class SpinHttpError extends Error {
	readonly status: number;

	constructor(status: number, error: string) {
		super(error);
		this.name = 'SpinHttpError';
		this.status = status;
	}
}

const NON_COMMITTED_CODES = new Set(['SETTLEMENT_CONFLICT']);

/**
 * Classify only responses the live route can currently produce before a
 * wallet write. Unknown failures stay ambiguous and use balance recovery.
 */
export function isNonCommittedSpinRejection(err: unknown): err is SpinHttpError {
	if (!(err instanceof SpinHttpError)) return false;
	if (err.status === 400 || err.status === 401) return true;
	return err.status === 409 && NON_COMMITTED_CODES.has(err.message);
}

export function messageForSpinRejection(err: SpinHttpError): string {
	if (err.status === 401) return 'Session expired — please sign in again.';
	switch (err.message) {
		case 'INSUFFICIENT_BALANCE':
			return 'Insufficient chips for this spin.';
		case 'SETTLEMENT_CONFLICT':
			return 'Spin settlement conflicted — please try again.';
		default:
			return 'Spin request rejected — please try again.';
	}
}
