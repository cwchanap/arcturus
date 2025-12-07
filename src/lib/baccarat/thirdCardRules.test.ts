/**
 * Unit tests for thirdCardRules
 */

import { describe, expect, test } from 'bun:test';
import {
	shouldPlayerDraw,
	shouldBankerDraw,
	shouldBankerDrawAfterPlayerDrew,
	explainBankerDecision,
} from './thirdCardRules';
import type { Card } from './types';

describe('shouldPlayerDraw', () => {
	test('should return true for player value 0-5', () => {
		expect(shouldPlayerDraw(0)).toBe(true);
		expect(shouldPlayerDraw(1)).toBe(true);
		expect(shouldPlayerDraw(2)).toBe(true);
		expect(shouldPlayerDraw(3)).toBe(true);
		expect(shouldPlayerDraw(4)).toBe(true);
		expect(shouldPlayerDraw(5)).toBe(true);
	});

	test('should return false for player value 6-7', () => {
		expect(shouldPlayerDraw(6)).toBe(false);
		expect(shouldPlayerDraw(7)).toBe(false);
	});

	test('should return false for naturals (8-9)', () => {
		expect(shouldPlayerDraw(8)).toBe(false);
		expect(shouldPlayerDraw(9)).toBe(false);
	});
});

describe('shouldBankerDraw - Player stood', () => {
	test('should return true for banker value 0-5 when player stood', () => {
		expect(shouldBankerDraw(0, null, true)).toBe(true);
		expect(shouldBankerDraw(1, null, true)).toBe(true);
		expect(shouldBankerDraw(2, null, true)).toBe(true);
		expect(shouldBankerDraw(3, null, true)).toBe(true);
		expect(shouldBankerDraw(4, null, true)).toBe(true);
		expect(shouldBankerDraw(5, null, true)).toBe(true);
	});

	test('should return false for banker value 6-7 when player stood', () => {
		expect(shouldBankerDraw(6, null, true)).toBe(false);
		expect(shouldBankerDraw(7, null, true)).toBe(false);
	});
});

describe('shouldBankerDraw - Player drew', () => {
	// Helper to create a card with specific rank
	const makeCard = (rank: Card['rank']): Card => ({ rank, suit: 'hearts' });

	test('should throw if player drew but no third card provided', () => {
		expect(() => shouldBankerDraw(3, null, false)).toThrow();
	});

	test('should always draw on banker value 0-2', () => {
		for (let playerThird = 0; playerThird <= 9; playerThird++) {
			const rank = playerThird === 10 ? '10' : playerThird === 0 ? '10' : String(playerThird);
			const card = makeCard(rank as Card['rank']);
			expect(shouldBankerDraw(0, card, false)).toBe(true);
			expect(shouldBankerDraw(1, card, false)).toBe(true);
			expect(shouldBankerDraw(2, card, false)).toBe(true);
		}
	});

	test('banker 3: draw unless player third was 8', () => {
		expect(shouldBankerDraw(3, makeCard('A'), false)).toBe(true); // 1
		expect(shouldBankerDraw(3, makeCard('2'), false)).toBe(true);
		expect(shouldBankerDraw(3, makeCard('3'), false)).toBe(true);
		expect(shouldBankerDraw(3, makeCard('7'), false)).toBe(true);
		expect(shouldBankerDraw(3, makeCard('8'), false)).toBe(false); // stands on 8
		expect(shouldBankerDraw(3, makeCard('9'), false)).toBe(true);
		expect(shouldBankerDraw(3, makeCard('10'), false)).toBe(true); // 0
	});

	test('banker 4: draw if player third was 2-7', () => {
		expect(shouldBankerDraw(4, makeCard('A'), false)).toBe(false); // 1
		expect(shouldBankerDraw(4, makeCard('2'), false)).toBe(true);
		expect(shouldBankerDraw(4, makeCard('3'), false)).toBe(true);
		expect(shouldBankerDraw(4, makeCard('7'), false)).toBe(true);
		expect(shouldBankerDraw(4, makeCard('8'), false)).toBe(false);
		expect(shouldBankerDraw(4, makeCard('9'), false)).toBe(false);
		expect(shouldBankerDraw(4, makeCard('10'), false)).toBe(false); // 0
	});

	test('banker 5: draw if player third was 4-7', () => {
		expect(shouldBankerDraw(5, makeCard('A'), false)).toBe(false); // 1
		expect(shouldBankerDraw(5, makeCard('2'), false)).toBe(false);
		expect(shouldBankerDraw(5, makeCard('3'), false)).toBe(false);
		expect(shouldBankerDraw(5, makeCard('4'), false)).toBe(true);
		expect(shouldBankerDraw(5, makeCard('5'), false)).toBe(true);
		expect(shouldBankerDraw(5, makeCard('6'), false)).toBe(true);
		expect(shouldBankerDraw(5, makeCard('7'), false)).toBe(true);
		expect(shouldBankerDraw(5, makeCard('8'), false)).toBe(false);
		expect(shouldBankerDraw(5, makeCard('9'), false)).toBe(false);
	});

	test('banker 6: draw if player third was 6 or 7', () => {
		expect(shouldBankerDraw(6, makeCard('A'), false)).toBe(false); // 1
		expect(shouldBankerDraw(6, makeCard('2'), false)).toBe(false);
		expect(shouldBankerDraw(6, makeCard('5'), false)).toBe(false);
		expect(shouldBankerDraw(6, makeCard('6'), false)).toBe(true);
		expect(shouldBankerDraw(6, makeCard('7'), false)).toBe(true);
		expect(shouldBankerDraw(6, makeCard('8'), false)).toBe(false);
	});

	test('banker 7: always stand', () => {
		expect(shouldBankerDraw(7, makeCard('A'), false)).toBe(false);
		expect(shouldBankerDraw(7, makeCard('5'), false)).toBe(false);
		expect(shouldBankerDraw(7, makeCard('7'), false)).toBe(false);
	});
});

describe('shouldBankerDrawAfterPlayerDrew', () => {
	test('should handle all banker values and player third card values', () => {
		// Banker 0-2: always draw
		expect(shouldBankerDrawAfterPlayerDrew(0, 8)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(1, 8)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(2, 8)).toBe(true);

		// Banker 3: draw except on 8
		expect(shouldBankerDrawAfterPlayerDrew(3, 0)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(3, 8)).toBe(false);

		// Banker 4: draw on 2-7
		expect(shouldBankerDrawAfterPlayerDrew(4, 1)).toBe(false);
		expect(shouldBankerDrawAfterPlayerDrew(4, 2)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(4, 7)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(4, 8)).toBe(false);

		// Banker 5: draw on 4-7
		expect(shouldBankerDrawAfterPlayerDrew(5, 3)).toBe(false);
		expect(shouldBankerDrawAfterPlayerDrew(5, 4)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(5, 7)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(5, 8)).toBe(false);

		// Banker 6: draw on 6-7
		expect(shouldBankerDrawAfterPlayerDrew(6, 5)).toBe(false);
		expect(shouldBankerDrawAfterPlayerDrew(6, 6)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(6, 7)).toBe(true);
		expect(shouldBankerDrawAfterPlayerDrew(6, 8)).toBe(false);

		// Banker 7: always stand
		expect(shouldBankerDrawAfterPlayerDrew(7, 6)).toBe(false);
		expect(shouldBankerDrawAfterPlayerDrew(7, 7)).toBe(false);
	});
});

describe('explainBankerDecision', () => {
	const makeCard = (rank: Card['rank']): Card => ({ rank, suit: 'hearts' });

	test('should explain natural stand', () => {
		const explanation = explainBankerDecision(8, null, false, false);
		expect(explanation).toContain('natural');
	});

	test('should explain stand on 7', () => {
		const explanation = explainBankerDecision(7, makeCard('5'), false, false);
		expect(explanation).toContain('stands on 7');
	});

	test('should explain player stood scenario', () => {
		const explanation = explainBankerDecision(4, null, true, true);
		expect(explanation).toContain('Player stood');
		expect(explanation).toContain('draws');
	});

	test('should explain complex third card rules', () => {
		const explanation = explainBankerDecision(3, makeCard('8'), false, false);
		expect(explanation).toContain('stands');
		expect(explanation).toContain('8');
	});
});
