import { describe, expect, test } from 'bun:test';
import type { Rank, Suit } from '../cards';
import { arrangeHouseWay } from './house-way';
import type { PaiGowCard } from './types';

const card = (rank: Rank, suit: Suit): PaiGowCard => ({ rank, suit });

describe('Pai Gow house way', () => {
	test('keeps the strongest valid Low pair from three Aces and two Kings', () => {
		const cards = [
			card(14, 'hearts'),
			card(14, 'diamonds'),
			card(14, 'clubs'),
			card(13, 'spades'),
			card(13, 'hearts'),
			card(7, 'diamonds'),
			card(3, 'clubs'),
		];

		const arrangement = arrangeHouseWay(cards);

		expect(arrangement.lowIndexes).toEqual([3, 4]);
		expect(arrangement.low).toEqual(cards.slice(3, 5));
		expect(arrangement.high).toEqual([...cards.slice(0, 3), ...cards.slice(5)]);
		expect(arrangement.highRanking).toEqual({
			category: 'three-of-kind',
			tieBreakers: [14, 7, 3],
		});
	});

	test('keeps the strongest valid Low pair from two Nines and two Fives', () => {
		const cards = [
			card(9, 'hearts'),
			card(9, 'diamonds'),
			card(5, 'clubs'),
			card(5, 'spades'),
			card(13, 'hearts'),
			card(7, 'diamonds'),
			card(3, 'clubs'),
		];

		const arrangement = arrangeHouseWay(cards);

		expect(arrangement.lowIndexes).toEqual([2, 3]);
		expect(arrangement.lowRanking).toEqual({ category: 'pair', tieBreakers: [5] });
		expect(arrangement.highRanking).toEqual({
			category: 'pair',
			tieBreakers: [9, 13, 7, 3],
		});
	});

	test('uses the King-Queen Low for a no-pair hand', () => {
		const cards = [
			card(14, 'hearts'),
			card(13, 'diamonds'),
			card(12, 'clubs'),
			card(9, 'spades'),
			card(7, 'hearts'),
			card(5, 'diamonds'),
			card(3, 'clubs'),
		];

		const arrangement = arrangeHouseWay(cards);

		expect(arrangement.lowIndexes).toEqual([1, 2]);
		expect(arrangement.low).toEqual(cards.slice(1, 3));
		expect(arrangement.high).toEqual([cards[0], ...cards.slice(3)]);
		expect(arrangement.highRanking).toEqual({
			category: 'high-card',
			tieBreakers: [14, 9, 7, 5, 3],
		});
	});

	test('preserves the strongest available straight flush', () => {
		const cards = [
			card(3, 'hearts'),
			card(4, 'hearts'),
			card(5, 'hearts'),
			card(6, 'hearts'),
			card(7, 'hearts'),
			card(8, 'hearts'),
			card(9, 'hearts'),
		];

		const arrangement = arrangeHouseWay(cards);

		expect(arrangement.lowIndexes).toEqual([0, 1]);
		expect(arrangement.high).toEqual(cards.slice(2));
		expect(arrangement.highRanking).toEqual({
			category: 'straight-flush',
			tieBreakers: [9],
		});
	});

	test('preserves a Royal Flush over the strongest possible Low', () => {
		const cards = [
			card(10, 'hearts'),
			card(11, 'hearts'),
			card(12, 'hearts'),
			card(13, 'hearts'),
			card(14, 'hearts'),
			card(2, 'diamonds'),
			card(3, 'diamonds'),
		];

		const arrangement = arrangeHouseWay(cards);

		expect(arrangement.lowIndexes).toEqual([5, 6]);
		expect(arrangement.low).toEqual(cards.slice(5));
		expect(arrangement.high).toEqual(cards.slice(0, 5));
		expect(arrangement.highRanking).toEqual({ category: 'royal-flush', tieBreakers: [] });
	});

	test('uses lexicographically smaller Low indexes when both hands tie', () => {
		const cards = [
			card(13, 'hearts'),
			card(13, 'diamonds'),
			card(13, 'clubs'),
			card(14, 'spades'),
			card(12, 'hearts'),
			card(11, 'diamonds'),
			card(10, 'clubs'),
		];

		const arrangement = arrangeHouseWay(cards);

		expect(arrangement.lowIndexes).toEqual([0, 1]);
		expect(arrangement.lowRanking).toEqual({ category: 'pair', tieBreakers: [13] });
		expect(arrangement.highRanking).toEqual({ category: 'straight', tieBreakers: [15] });
	});
});
