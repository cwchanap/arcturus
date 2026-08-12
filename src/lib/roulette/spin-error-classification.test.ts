import { describe, expect, it } from 'bun:test';
import {
	SpinHttpError,
	isNonCommittedSpinRejection,
	messageForSpinRejection,
} from './spin-error-classification';

describe('roulette spin error classification', () => {
	it('keeps only concrete current-page non-commit responses', () => {
		expect(isNonCommittedSpinRejection(new SpinHttpError(400, 'INVALID_COMMAND'))).toBe(true);
		expect(isNonCommittedSpinRejection(new SpinHttpError(400, 'INSUFFICIENT_BALANCE'))).toBe(true);
		expect(isNonCommittedSpinRejection(new SpinHttpError(409, 'SETTLEMENT_CONFLICT'))).toBe(true);
		expect(isNonCommittedSpinRejection(new SpinHttpError(500, 'INTERNAL_ERROR'))).toBe(false);
		expect(isNonCommittedSpinRejection(new TypeError('network'))).toBe(false);
	});

	it('does not classify removed rate-limit or replay-expiry branches', () => {
		expect(isNonCommittedSpinRejection(new SpinHttpError(429, 'RATE_LIMITED'))).toBe(false);
		expect(isNonCommittedSpinRejection(new SpinHttpError(409, 'SYNC_ID_REPLAY_EXPIRED'))).toBe(
			false,
		);
	});

	it('maps live rejection codes to actionable messages', () => {
		expect(messageForSpinRejection(new SpinHttpError(400, 'INSUFFICIENT_BALANCE'))).toBe(
			'Insufficient chips for this spin.',
		);
		expect(messageForSpinRejection(new SpinHttpError(409, 'SETTLEMENT_CONFLICT'))).toBe(
			'Spin settlement conflicted — please try again.',
		);
		expect(messageForSpinRejection(new SpinHttpError(400, 'INVALID_COMMAND'))).toBe(
			'Spin request rejected — please try again.',
		);
	});

	it('directs 401 rejections to sign in again', () => {
		expect(messageForSpinRejection(new SpinHttpError(401, 'UNAUTHORIZED'))).toBe(
			'Session expired — please sign in again.',
		);
	});
});
