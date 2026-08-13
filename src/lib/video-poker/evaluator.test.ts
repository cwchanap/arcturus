import { describe, expect, test } from 'bun:test';
import { evaluateHand } from './evaluator';
import type { Card, Rank, Suit } from './types';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });
const category = (cards: Card[]) => evaluateHand(cards).category;

describe('evaluateHand', () => {
	test('recognizes every Jacks or Better category', () => {
		expect(
			category([
				c(10, 'hearts'),
				c(11, 'hearts'),
				c(12, 'hearts'),
				c(13, 'hearts'),
				c(14, 'hearts'),
			]),
		).toBe('royal-flush');
		expect(
			category([c(5, 'spades'), c(6, 'spades'), c(7, 'spades'), c(8, 'spades'), c(9, 'spades')]),
		).toBe('straight-flush');
		expect(
			category([c(8, 'hearts'), c(8, 'diamonds'), c(8, 'clubs'), c(8, 'spades'), c(2, 'hearts')]),
		).toBe('four-of-kind');
		expect(
			category([c(7, 'hearts'), c(7, 'diamonds'), c(7, 'clubs'), c(13, 'hearts'), c(13, 'spades')]),
		).toBe('full-house');
		expect(
			category([c(2, 'clubs'), c(5, 'clubs'), c(8, 'clubs'), c(11, 'clubs'), c(14, 'clubs')]),
		).toBe('flush');
		expect(
			category([c(5, 'hearts'), c(6, 'diamonds'), c(7, 'clubs'), c(8, 'spades'), c(9, 'hearts')]),
		).toBe('straight');
		expect(
			category([c(4, 'hearts'), c(4, 'diamonds'), c(4, 'clubs'), c(9, 'spades'), c(13, 'hearts')]),
		).toBe('three-of-kind');
		expect(
			category([c(3, 'hearts'), c(3, 'diamonds'), c(12, 'clubs'), c(12, 'spades'), c(7, 'hearts')]),
		).toBe('two-pair');
		expect(
			category([c(11, 'hearts'), c(11, 'diamonds'), c(3, 'clubs'), c(7, 'spades'), c(9, 'hearts')]),
		).toBe('jacks-or-better');
		expect(
			category([c(10, 'hearts'), c(10, 'diamonds'), c(3, 'clubs'), c(7, 'spades'), c(9, 'hearts')]),
		).toBe('nothing');
	});

	test('recognizes the wheel straight', () => {
		expect(
			category([c(14, 'hearts'), c(2, 'diamonds'), c(3, 'clubs'), c(4, 'spades'), c(5, 'hearts')]),
		).toBe('straight');
	});

	test('classifies a suited wheel as Straight Flush, not Royal Flush', () => {
		expect(
			category([c(14, 'spades'), c(2, 'spades'), c(3, 'spades'), c(4, 'spades'), c(5, 'spades')]),
		).toBe('straight-flush');
	});

	test('counts a pair of aces as Jacks or Better', () => {
		expect(
			category([c(14, 'hearts'), c(14, 'clubs'), c(3, 'diamonds'), c(7, 'spades'), c(9, 'hearts')]),
		).toBe('jacks-or-better');
	});

	test('requires exactly five cards', () => {
		expect(() => evaluateHand([c(14, 'hearts')])).toThrow(RangeError);
	});
});
