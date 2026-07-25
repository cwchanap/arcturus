import { describe, expect, test } from 'bun:test';
import { RankedServiceError } from './protocol';
import { getRankedAdapter } from './registry';

describe('ranked adapter registry', () => {
	test('returns the immutable Blackjack v1 adapter only for its exact key', () => {
		const adapter = getRankedAdapter('blackjack', 'blackjack-ranked-v1');

		expect(adapter.gameType).toBe('blackjack');
		expect(adapter.rulesetVersion).toBe('blackjack-ranked-v1');
	});

	test.each([
		['blackjack', 'blackjack-ranked-v2'],
		['poker', 'blackjack-ranked-v1'],
	])('rejects unsupported adapter pair %s:%s as an invalid request', (gameType, rulesetVersion) => {
		expect(() => getRankedAdapter(gameType, rulesetVersion)).toThrow(
			expect.objectContaining<Partial<RankedServiceError>>({ code: 'INVALID_REQUEST' }),
		);
	});
});
