import { describe, expect, it } from 'bun:test';
import {
	SpinHttpError,
	isRetriableSpinError,
	isNonCommittedSpinRejection,
	messageForSpinRejection,
} from './spin-error-classification';

describe('SpinHttpError', () => {
	it('preserves status and error code', () => {
		const err = new SpinHttpError(409, 'CONCURRENT_MODIFICATION');
		expect(err.status).toBe(409);
		expect(err.message).toBe('CONCURRENT_MODIFICATION');
		expect(err.name).toBe('SpinHttpError');
		expect(err instanceof Error).toBe(true);
	});

	it('preserves currentBalance when provided', () => {
		const err = new SpinHttpError(400, 'INSUFFICIENT_BALANCE', 400);
		expect(err.status).toBe(400);
		expect(err.currentBalance).toBe(400);
	});

	it('defaults currentBalance to undefined when not provided', () => {
		const err = new SpinHttpError(429, 'RATE_LIMITED');
		expect(err.currentBalance).toBeUndefined();
	});
});

describe('isRetriableSpinError', () => {
	it('returns true for TypeError (network failure)', () => {
		expect(isRetriableSpinError(new TypeError('fetch failed'))).toBe(true);
	});

	it('returns true for AbortError (fetch timeout)', () => {
		const err = new DOMException('aborted', 'AbortError');
		expect(isRetriableSpinError(err)).toBe(true);
	});

	it('returns false for generic Error', () => {
		expect(isRetriableSpinError(new Error('something'))).toBe(false);
	});

	it('returns false for null/undefined', () => {
		expect(isRetriableSpinError(null)).toBe(false);
		expect(isRetriableSpinError(undefined)).toBe(false);
	});

	// Status × code matrix for SpinHttpError
	const retriableCases: Array<[number, string, string]> = [
		[500, 'INTERNAL_ERROR', '5xx server error'],
		[502, 'HTTP 502', '502 bad gateway'],
		[503, 'HTTP 503', '503 service unavailable'],
		[409, 'CONCURRENT_MODIFICATION', '409 concurrent modification (idempotent replay)'],
	];

	for (const [status, code, desc] of retriableCases) {
		it(`returns true for ${desc} (${status} ${code})`, () => {
			expect(isRetriableSpinError(new SpinHttpError(status, code))).toBe(true);
		});
	}

	const nonRetriableCases: Array<[number, string, string]> = [
		[400, 'INVALID_BETS', '400 validation error'],
		[400, 'INSUFFICIENT_BALANCE', '400 insufficient balance'],
		[400, 'DELTA_EXCEEDS_LIMIT', '400 delta backstop'],
		[401, 'UNAUTHORIZED', '401 unauthenticated'],
		[403, 'FORBIDDEN', '403 forbidden'],
		[409, 'MP_ESCROW_ACTIVE', '409 MP escrow (non-retriable 409)'],
		[409, 'SYNC_ID_REUSE_MISMATCH', '409 syncId reuse mismatch (non-retriable 409)'],
		[429, 'RATE_LIMITED', '429 rate limited'],
	];

	for (const [status, code, desc] of nonRetriableCases) {
		it(`returns false for ${desc} (${status} ${code})`, () => {
			expect(isRetriableSpinError(new SpinHttpError(status, code))).toBe(false);
		});
	}
});

describe('isNonCommittedSpinRejection', () => {
	it('returns false for TypeError (network failure — not a rejection)', () => {
		expect(isNonCommittedSpinRejection(new TypeError('fetch failed'))).toBe(false);
	});

	it('returns false for generic Error', () => {
		expect(isNonCommittedSpinRejection(new Error('something'))).toBe(false);
	});

	it('returns false for null/undefined', () => {
		expect(isNonCommittedSpinRejection(null)).toBe(false);
		expect(isNonCommittedSpinRejection(undefined)).toBe(false);
	});

	// Status × code matrix: definitive rejections (server did NOT commit)
	const rejectionCases: Array<[number, string, string]> = [
		[400, 'INVALID_BETS', '400 validation error'],
		[400, 'INSUFFICIENT_BALANCE', '400 insufficient balance'],
		[400, 'DELTA_EXCEEDS_LIMIT', '400 delta backstop'],
		[400, 'INVALID_SYNC_ID', '400 invalid syncId'],
		[400, 'INVALID_TOTAL_BET', '400 invalid total bet'],
		[400, 'POSITION_LIMIT_EXCEEDED', '400 position limit'],
		[400, 'TOO_MANY_BETS', '400 too many bets'],
		[401, 'UNAUTHORIZED', '401 unauthenticated'],
		[403, 'FORBIDDEN', '403 forbidden'],
		[429, 'RATE_LIMITED', '429 rate limited'],
		[409, 'MP_ESCROW_ACTIVE', '409 MP escrow'],
		[409, 'SYNC_ID_REUSE_MISMATCH', '409 syncId reuse mismatch'],
	];

	for (const [status, code, desc] of rejectionCases) {
		it(`returns true for ${desc} (${status} ${code})`, () => {
			expect(isNonCommittedSpinRejection(new SpinHttpError(status, code))).toBe(true);
		});
	}

	// Non-rejection cases: server MAY have committed
	const nonRejectionCases: Array<[number, string, string]> = [
		[500, 'INTERNAL_ERROR', '5xx server error (may have committed)'],
		[502, 'HTTP 502', '502 bad gateway (may have committed)'],
		[503, 'HTTP 503', '503 service unavailable (may have committed)'],
		[
			409,
			'CONCURRENT_MODIFICATION',
			'409 concurrent modification (retriable — may have committed)',
		],
	];

	for (const [status, code, desc] of nonRejectionCases) {
		it(`returns false for ${desc} (${status} ${code})`, () => {
			expect(isNonCommittedSpinRejection(new SpinHttpError(status, code))).toBe(false);
		});
	}
});

describe('messageForSpinRejection', () => {
	it('returns specific message for MP_ESCROW_ACTIVE', () => {
		const msg = messageForSpinRejection(new SpinHttpError(409, 'MP_ESCROW_ACTIVE'));
		expect(msg).toContain('multiplayer poker');
	});

	it('returns specific message for RATE_LIMITED', () => {
		const msg = messageForSpinRejection(new SpinHttpError(429, 'RATE_LIMITED'));
		expect(msg).toContain('wait');
	});

	it('returns specific message for INSUFFICIENT_BALANCE', () => {
		const msg = messageForSpinRejection(new SpinHttpError(400, 'INSUFFICIENT_BALANCE'));
		expect(msg).toContain('Insufficient');
	});

	it('returns specific message for SYNC_ID_REUSE_MISMATCH', () => {
		const msg = messageForSpinRejection(new SpinHttpError(409, 'SYNC_ID_REUSE_MISMATCH'));
		expect(msg).toContain('conflict');
	});

	it('returns generic message for HTTP-prefixed unknown codes', () => {
		const msg = messageForSpinRejection(new SpinHttpError(400, 'HTTP 400'));
		expect(msg).toBe('Spin rejected — please try again.');
	});

	it('returns prefixed message for unknown error codes', () => {
		const msg = messageForSpinRejection(new SpinHttpError(400, 'SOME_NEW_ERROR'));
		expect(msg).toBe('Spin rejected: SOME_NEW_ERROR');
	});
});

describe('error classification mutual exclusivity', () => {
	// Verify that retriable and non-committed rejection are mutually
	// exclusive for all SpinHttpError status/code combinations — a spin
	// error should never be both retriable AND a definitive rejection.
	const allCases: Array<[number, string]> = [
		[400, 'INVALID_BETS'],
		[400, 'INSUFFICIENT_BALANCE'],
		[400, 'DELTA_EXCEEDS_LIMIT'],
		[401, 'UNAUTHORIZED'],
		[403, 'FORBIDDEN'],
		[409, 'CONCURRENT_MODIFICATION'],
		[409, 'MP_ESCROW_ACTIVE'],
		[409, 'SYNC_ID_REUSE_MISMATCH'],
		[429, 'RATE_LIMITED'],
		[500, 'INTERNAL_ERROR'],
		[502, 'HTTP 502'],
		[503, 'HTTP 503'],
	];

	for (const [status, code] of allCases) {
		it(`${status} ${code} is not both retriable and non-committed rejection`, () => {
			const err = new SpinHttpError(status, code);
			const retriable = isRetriableSpinError(err);
			const rejection = isNonCommittedSpinRejection(err);
			expect(retriable && rejection).toBe(false);
		});
	}
});
