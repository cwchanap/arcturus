import { describe, expect, test } from 'bun:test';
import type { Card, Rank, Suit } from '../cards';
import {
	compareThreeCardHands,
	dealerQualifies,
	evaluateThreeCardHand,
	resolvePlayedHand,
} from './rules';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

const evaluate = (cards: readonly Card[]) => evaluateThreeCardHand(cards);

describe('evaluateThreeCardHand', () => {
	test('A-K-Q is the highest straight', () => {
		const hand = evaluate([c(14, 'spades'), c(13, 'hearts'), c(12, 'diamonds')]);
		expect(hand.category).toBe('straight');
		expect(hand.tieBreakers).toEqual([14]);
		expect(
			compareThreeCardHands(hand, evaluate([c(13, 'spades'), c(12, 'hearts'), c(11, 'diamonds')])),
		).toBe(1);
	});

	test('A-2-3 is the lowest straight with straightHigh 3', () => {
		const hand = evaluate([c(14, 'spades'), c(2, 'hearts'), c(3, 'diamonds')]);
		expect(hand.category).toBe('straight');
		expect(hand.tieBreakers).toEqual([3]);
	});

	test('K-A-2 is a high card, not a straight', () => {
		const hand = evaluate([c(13, 'spades'), c(14, 'hearts'), c(2, 'diamonds')]);
		expect(hand.category).toBe('high-card');
		expect(hand.tieBreakers).toEqual([14, 13, 2]);
	});

	test('same-suit A-2-3 is a straight flush', () => {
		const hand = evaluate([c(14, 'spades'), c(2, 'spades'), c(3, 'spades')]);
		expect(hand.category).toBe('straight-flush');
		expect(hand.tieBreakers).toEqual([3]);
	});

	test('three of a kind is detected with the trio rank', () => {
		const hand = evaluate([c(9, 'spades'), c(9, 'hearts'), c(9, 'diamonds')]);
		expect(hand.category).toBe('three-of-kind');
		expect(hand.tieBreakers).toEqual([9]);
	});

	test('requires exactly three cards', () => {
		expect(() => evaluate([])).toThrow(RangeError);
		expect(() => evaluate([c(14, 'hearts')])).toThrow(RangeError);
		expect(() => evaluate([c(14, 'hearts'), c(13, 'hearts')])).toThrow(RangeError);
		expect(() =>
			evaluate([c(14, 'hearts'), c(13, 'hearts'), c(12, 'hearts'), c(11, 'hearts')]),
		).toThrow(RangeError);
	});
});

describe('compareThreeCardHands category precedence', () => {
	test('straight flush beats three of a kind', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(4, 'hearts'), c(5, 'hearts'), c(6, 'hearts')]),
				evaluate([c(9, 'spades'), c(9, 'hearts'), c(9, 'diamonds')]),
			),
		).toBe(1);
	});

	test('three of a kind beats straight', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(2, 'spades'), c(2, 'hearts'), c(2, 'diamonds')]),
				evaluate([c(14, 'spades'), c(13, 'hearts'), c(12, 'diamonds')]),
			),
		).toBe(1);
	});

	test('straight beats flush', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(4, 'hearts'), c(5, 'clubs'), c(6, 'spades')]),
				evaluate([c(14, 'hearts'), c(10, 'hearts'), c(8, 'hearts')]),
			),
		).toBe(1);
	});

	test('flush beats pair', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(2, 'hearts'), c(7, 'hearts'), c(9, 'hearts')]),
				evaluate([c(14, 'spades'), c(14, 'hearts'), c(3, 'diamonds')]),
			),
		).toBe(1);
	});

	test('pair beats high card', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(2, 'spades'), c(2, 'hearts'), c(3, 'diamonds')]),
				evaluate([c(14, 'spades'), c(13, 'hearts'), c(2, 'diamonds')]),
			),
		).toBe(1);
	});
});

describe('compareThreeCardHands tie breakers', () => {
	test('pair compares pair rank before kicker', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(10, 'spades'), c(10, 'hearts'), c(3, 'diamonds')]),
				evaluate([c(9, 'clubs'), c(9, 'spades'), c(14, 'diamonds')]),
			),
		).toBe(1);
		expect(
			compareThreeCardHands(
				evaluate([c(9, 'spades'), c(9, 'hearts'), c(7, 'diamonds')]),
				evaluate([c(9, 'clubs'), c(9, 'spades'), c(5, 'diamonds')]),
			),
		).toBe(1);
	});

	test('flush compares lexicographically', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(14, 'hearts'), c(10, 'hearts'), c(8, 'hearts')]),
				evaluate([c(14, 'clubs'), c(10, 'clubs'), c(7, 'clubs')]),
			),
		).toBe(1);
	});

	test('high card compares lexicographically', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(14, 'spades'), c(13, 'hearts'), c(2, 'diamonds')]),
				evaluate([c(14, 'clubs'), c(13, 'spades'), c(3, 'diamonds')]),
			),
		).toBe(-1);
	});

	test('same ranks with different suits tie', () => {
		expect(
			compareThreeCardHands(
				evaluate([c(4, 'hearts'), c(5, 'clubs'), c(6, 'spades')]),
				evaluate([c(4, 'spades'), c(5, 'diamonds'), c(6, 'hearts')]),
			),
		).toBe(0);
	});
});

describe('dealerQualifies', () => {
	test('queen-high qualifies', () => {
		expect(dealerQualifies(evaluate([c(12, 'hearts'), c(9, 'clubs'), c(2, 'spades')]))).toBe(true);
	});

	test('jack-high does not qualify', () => {
		expect(dealerQualifies(evaluate([c(11, 'hearts'), c(10, 'clubs'), c(8, 'spades')]))).toBe(
			false,
		);
	});

	test('every pair-or-better evaluation qualifies', () => {
		expect(dealerQualifies(evaluate([c(2, 'spades'), c(2, 'hearts'), c(3, 'diamonds')]))).toBe(
			true,
		);
		expect(dealerQualifies(evaluate([c(14, 'spades'), c(2, 'spades'), c(3, 'spades')]))).toBe(true);
	});
});

describe('resolvePlayedHand payouts for ante 10', () => {
	test('dealer not qualified returns ante, pushes play, wins ante', () => {
		const result = resolvePlayedHand(
			[c(12, 'spades'), c(11, 'hearts'), c(9, 'diamonds')],
			[c(11, 'clubs'), c(10, 'spades'), c(8, 'hearts')],
			10,
		);
		expect(result.outcome).toBe('dealer-not-qualified');
		expect(result.dealerQualified).toBe(false);
		expect(result.totalWager).toBe(20);
		expect(result.grossPayout).toBe(30);
		expect(result.netDelta).toBe(10);
	});

	test('player win pays 1:1 on ante and play', () => {
		const result = resolvePlayedHand(
			[c(10, 'spades'), c(10, 'hearts'), c(3, 'diamonds')],
			[c(9, 'clubs'), c(9, 'spades'), c(14, 'diamonds')],
			10,
		);
		expect(result.outcome).toBe('player-win');
		expect(result.dealerQualified).toBe(true);
		expect(result.totalWager).toBe(20);
		expect(result.grossPayout).toBe(40);
		expect(result.netDelta).toBe(20);
	});

	test('tie returns both wagers', () => {
		const result = resolvePlayedHand(
			[c(12, 'hearts'), c(11, 'clubs'), c(9, 'diamonds')],
			[c(12, 'spades'), c(11, 'spades'), c(9, 'hearts')],
			10,
		);
		expect(result.outcome).toBe('tie');
		expect(result.dealerQualified).toBe(true);
		expect(result.totalWager).toBe(20);
		expect(result.grossPayout).toBe(20);
		expect(result.netDelta).toBe(0);
	});

	test('dealer win takes both wagers', () => {
		const result = resolvePlayedHand(
			[c(9, 'clubs'), c(9, 'spades'), c(2, 'diamonds')],
			[c(4, 'hearts'), c(5, 'clubs'), c(6, 'spades')],
			10,
		);
		expect(result.outcome).toBe('dealer-win');
		expect(result.dealerQualified).toBe(true);
		expect(result.totalWager).toBe(20);
		expect(result.grossPayout).toBe(0);
		expect(result.netDelta).toBe(-20);
	});

	test('returns frozen round data', () => {
		const result = resolvePlayedHand(
			[c(12, 'spades'), c(11, 'hearts'), c(9, 'diamonds')],
			[c(11, 'clubs'), c(10, 'spades'), c(8, 'hearts')],
			10,
		);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.playerHand)).toBe(true);
		expect(Object.isFrozen(result.dealerHand)).toBe(true);
		expect(Object.isFrozen(result.playerEvaluation)).toBe(true);
		expect(Object.isFrozen(result.dealerEvaluation)).toBe(true);
	});
});
