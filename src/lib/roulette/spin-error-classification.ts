import { ROULETTE_MESSAGES, rouletteTranslator } from '../i18n/messages/roulette';
import type { Locale } from '../i18n/locale';
import type { MessageKey } from '../i18n/translate';

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

const REJECTION_KEYS: Partial<Record<number, MessageKey<typeof ROULETTE_MESSAGES>>> = {
	401: 'rejectSessionExpired',
};

/**
 * Resolve a rejected spin to localized copy. The wire status/code stay
 * language-neutral; only this presentation mapping reads the locale.
 */
export function messageForSpinRejection(err: SpinHttpError, locale: Locale): string {
	const t = rouletteTranslator(locale);
	const statusKey = REJECTION_KEYS[err.status];
	if (statusKey) return t(statusKey);
	switch (err.message) {
		case 'INSUFFICIENT_BALANCE':
			return t('rejectInsufficientBalance');
		case 'SETTLEMENT_CONFLICT':
			return t('rejectSettlementConflict');
		default:
			return t('rejectDefault');
	}
}
