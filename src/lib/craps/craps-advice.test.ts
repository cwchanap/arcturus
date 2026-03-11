import { describe, test, expect } from 'bun:test';
import { aggregateBets } from '../../pages/api/craps-advice';

describe('aggregateBets', () => {
	test('aggregates Come bets at the same point with different odds into one entry', () => {
		// In a longer session it is normal to accumulate multiple Come bets at the same
		// number with different odds increments. They must collapse to a single entry by
		// type/point so the payload stays within MAX_ACTIVE_BETS.
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'come', amount: 100, point: 6, odds: 400 },
		]);

		expect(result).toHaveLength(1);
		expect(result[0].amount).toBe(200);
		expect(result[0].odds).toBe(600);
	});

	test('keeps distinct bets at different points separate', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'come', amount: 100, point: 8, odds: 100 },
		]);

		expect(result).toHaveLength(2);
	});

	test('keeps distinct bet types separate even at the same point', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'dontCome', amount: 100, point: 6, odds: 200 },
		]);

		expect(result).toHaveLength(2);
	});

	test('aggregates bets with no odds', () => {
		const result = aggregateBets([
			{ id: '1', type: 'passLine', amount: 50, point: null },
			{ id: '2', type: 'passLine', amount: 75, point: null },
		]);

		expect(result).toHaveLength(1);
		expect(result[0].amount).toBe(125);
	});
});
