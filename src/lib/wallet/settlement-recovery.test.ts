import { describe, expect, test } from 'bun:test';
import { ensureSettlementRecoveryControls } from './settlement-recovery';

describe('ensureSettlementRecoveryControls', () => {
	test('returns nulls without throwing when document is undefined', () => {
		const originalDocument = globalThis.document;
		// @ts-expect-error -- deliberately remove document to simulate SSR/test env
		delete globalThis.document;
		try {
			const result = ensureSettlementRecoveryControls({ attachTo: null });
			expect(result).toEqual({ container: null, retry: null, reset: null });
		} finally {
			if (originalDocument !== undefined) {
				globalThis.document = originalDocument;
			}
		}
	});
});
