/**
 * Unit tests for thirdCardRules
 */

import { describe, expect, test } from 'bun:test';
import {
	shouldPlayerDraw,
	shouldBankerDraw,
	shouldBankerDrawAfterPlayerDrew,
	explainBankerDecision,
	getBankerRulesDescription,
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
		for (let playerThird = 0; playerThird <= 10; playerThird++) {
			const rank = playerThird === 0 || playerThird === 10 ? '10' : String(playerThird);
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

	test('should explain player stood with banker standing', () => {
		const explanation = explainBankerDecision(6, null, true, false);
		expect(explanation).toContain('Player stood');
		expect(explanation).toContain('stands');
	});

	test('should explain invalid state when player drew but no third card provided', () => {
		const explanation = explainBankerDecision(3, null, false, false);
		expect(explanation).toContain('Invalid state');
	});

	test('should explain banker 0-2 always draws', () => {
		const draw = explainBankerDecision(0, makeCard('5'), false, true);
		expect(draw).toContain('always draws on 0-2');

		const draw2 = explainBankerDecision(2, makeCard('3'), false, true);
		expect(draw2).toContain('always draws on 0-2');
	});

	test('should explain banker 3 with player third 8 (stands)', () => {
		const explanation = explainBankerDecision(3, makeCard('8'), false, false);
		expect(explanation).toContain('stands on 8');
	});

	test('should explain banker 3 with player third not 8 (draws)', () => {
		const explanation = explainBankerDecision(3, makeCard('5'), false, true);
		expect(explanation).toContain('draws otherwise');
	});

	test('should explain banker 4 draws on 2-7', () => {
		const explanation = explainBankerDecision(4, makeCard('5'), false, true);
		expect(explanation).toContain('draws on 2-7');
	});

	test('should explain banker 4 stands otherwise', () => {
		const explanation = explainBankerDecision(4, makeCard('9'), false, false);
		expect(explanation).toContain('stands otherwise');
	});

	test('should explain banker 5 draws on 4-7', () => {
		const explanation = explainBankerDecision(5, makeCard('6'), false, true);
		expect(explanation).toContain('draws on 4-7');
	});

	test('should explain banker 5 stands otherwise', () => {
		const explanation = explainBankerDecision(5, makeCard('2'), false, false);
		expect(explanation).toContain('stands otherwise');
	});

	test('should explain banker 6 draws on 6-7', () => {
		const explanation = explainBankerDecision(6, makeCard('7'), false, true);
		expect(explanation).toContain('draws on 6-7');
	});

	test('should explain banker 6 stands otherwise', () => {
		const explanation = explainBankerDecision(6, makeCard('3'), false, false);
		expect(explanation).toContain('stands otherwise');
	});

	test('should explain default case for out-of-range banker value', () => {
		// Values >= 8 are caught by the natural check, so use a value
		// that is not 0-7 and not >= 8 — e.g. a negative number — to
		// hit the default branch.
		const explanation = explainBankerDecision(-1, makeCard('5'), false, false);
		expect(explanation).toContain('Banker');
	});
});

describe('getBankerRulesDescription', () => {
	test('returns a human-readable description of all banker rules', () => {
		const description = getBankerRulesDescription();
		expect(description).toContain('Banker Third-Card Rules');
		expect(description).toContain('0-2: Always draw');
		expect(description).toContain("3: Draw unless Player's third card was 8");
		expect(description).toContain("4: Draw if Player's third card was 2-7");
		expect(description).toContain("5: Draw if Player's third card was 4-7");
		expect(description).toContain("6: Draw if Player's third card was 6-7");
		expect(description).toContain('7: Always stand');
		expect(description).toContain('8-9: Natural (no draw)');
		expect(description).toContain('If Player stood (6-7): Banker draws on 0-5, stands on 6-7');
	});

	test('returns a trimmed string with no leading/trailing whitespace', () => {
		const description = getBankerRulesDescription();
		expect(description).toBe(description.trim());
	});
});
