import { describe, expect, test } from 'bun:test';
import { newSettlementId, SETTLEMENT_ID_RE } from './settlement-id';

describe('settlement IDs', () => {
	test('accepts the documented safe identifier alphabet', () => {
		expect(SETTLEMENT_ID_RE.test('blackjack-123_ABC')).toBe(true);
	});

	test('rejects spaces', () => {
		expect(SETTLEMENT_ID_RE.test('bad id')).toBe(false);
	});

	test('rejects identifiers longer than 128 characters', () => {
		expect(SETTLEMENT_ID_RE.test('x'.repeat(129))).toBe(false);
	});

	test('generates a game-prefixed identifier', () => {
		expect(newSettlementId('blackjack')).toMatch(/^blackjack-[A-Za-z0-9_-]+$/);
	});
});
