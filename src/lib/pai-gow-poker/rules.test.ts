import { describe, expect, test } from 'bun:test';
import {
	comparePaiGowRankings,
	getArrangement,
	getArrangementError,
	rankPaiGowFiveCardHand,
	rankPaiGowTwoCardHand,
	resolvePaiGowRound,
} from './rules';
import type { PaiGowArrangement, PaiGowCard, PaiGowHandRanking, PaiGowJoker } from './types';
import type { Rank, Suit } from '../cards';

const card = (rank: Rank, suit: Suit): PaiGowCard => ({ rank, suit });
const joker: PaiGowJoker = { rank: 'joker', suit: 'joker' };

const arrangement = (
	highRanking: PaiGowHandRanking,
	lowRanking: PaiGowHandRanking,
): PaiGowArrangement => ({
	lowIndexes: [0, 1],
	high: [],
	low: [],
	highRanking,
	lowRanking,
});

describe('Pai Gow ranking comparison', () => {
	test('longer high-card tie breakers win after a shared prefix', () => {
		expect(
			comparePaiGowRankings(
				{ category: 'high-card', tieBreakers: [13, 12, 7, 5, 3] },
				{ category: 'high-card', tieBreakers: [13, 12] },
			),
		).toBe(1);
	});

	test('longer pair tie breakers win after the shared pair rank', () => {
		expect(
			comparePaiGowRankings(
				{ category: 'pair', tieBreakers: [9, 13, 7, 3] },
				{ category: 'pair', tieBreakers: [9] },
			),
		).toBe(1);
	});
});

describe('Pai Gow hand ranking', () => {
	test('normalizes Broadway and wheel straights', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(10, 'spades'),
				card(11, 'hearts'),
				card(12, 'clubs'),
				card(13, 'diamonds'),
				card(14, 'spades'),
			]),
		).toEqual({ category: 'straight', tieBreakers: [15] });

		expect(
			rankPaiGowFiveCardHand([
				card(14, 'spades'),
				card(2, 'hearts'),
				card(3, 'clubs'),
				card(4, 'diamonds'),
				card(5, 'spades'),
			]),
		).toEqual({ category: 'straight', tieBreakers: [14] });
	});

	test('normalizes Broadway and wheel straight flushes', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(10, 'spades'),
				card(11, 'spades'),
				card(12, 'spades'),
				card(13, 'spades'),
				card(14, 'spades'),
			]),
		).toEqual({ category: 'royal-flush', tieBreakers: [] });

		expect(
			rankPaiGowFiveCardHand([
				card(14, 'spades'),
				card(2, 'spades'),
				card(3, 'spades'),
				card(4, 'spades'),
				card(5, 'spades'),
			]),
		).toEqual({ category: 'straight-flush', tieBreakers: [14] });
	});

	test('ranks two-card pairs and descending high cards', () => {
		expect(rankPaiGowTwoCardHand([card(9, 'hearts'), card(9, 'spades')])).toEqual({
			category: 'pair',
			tieBreakers: [9],
		});
		expect(rankPaiGowTwoCardHand([card(7, 'hearts'), card(13, 'spades')])).toEqual({
			category: 'high-card',
			tieBreakers: [13, 7],
		});
	});

	test('treats a Joker as an Ace in the Low hand', () => {
		expect(rankPaiGowTwoCardHand([joker, card(14, 'spades')])).toEqual({
			category: 'pair',
			tieBreakers: [14],
		});
		expect(rankPaiGowTwoCardHand([joker, card(13, 'spades')])).toEqual({
			category: 'high-card',
			tieBreakers: [14, 13],
		});
	});

	test('ranks four Aces and a Joker as Five Aces', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(14, 'hearts'),
				card(14, 'diamonds'),
				card(14, 'clubs'),
				card(14, 'spades'),
				joker,
			]),
		).toEqual({ category: 'five-aces', tieBreakers: [] });
	});

	test('uses a suited Ace to complete a Royal Flush', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(13, 'spades'),
				card(12, 'spades'),
				card(11, 'spades'),
				card(10, 'spades'),
				joker,
			]),
		).toEqual({ category: 'royal-flush', tieBreakers: [] });
	});

	test('uses a Joker to complete a wheel Straight', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(14, 'spades'),
				card(2, 'hearts'),
				card(3, 'clubs'),
				card(4, 'diamonds'),
				joker,
			]),
		).toEqual({ category: 'straight', tieBreakers: [14] });
	});

	test('uses Ace when no special Joker completion is available', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(13, 'spades'),
				card(9, 'hearts'),
				card(7, 'clubs'),
				card(2, 'diamonds'),
				joker,
			]),
		).toEqual({ category: 'high-card', tieBreakers: [14, 13, 9, 7, 2] });
	});

	test('does not use a Joker as an arbitrary rank to make Trips', () => {
		const ranking = rankPaiGowFiveCardHand([
			card(13, 'hearts'),
			card(13, 'spades'),
			card(7, 'clubs'),
			card(3, 'diamonds'),
			joker,
		]);

		expect(ranking.category).toBe('pair');
		expect(ranking.tieBreakers[0]).toBe(13);
	});

	test('completes a Flush with four suited cards plus a Joker', () => {
		expect(
			rankPaiGowFiveCardHand([
				card(14, 'spades'),
				card(8, 'spades'),
				card(5, 'spades'),
				card(2, 'spades'),
				joker,
			]),
		).toEqual({ category: 'flush', tieBreakers: [14, 13, 8, 5, 2] });
	});
});

describe('Pai Gow arrangements', () => {
	test('allows a high-card five-card High against a same-prefix Low', () => {
		const cards = [
			card(13, 'hearts'),
			card(12, 'spades'),
			card(7, 'diamonds'),
			card(5, 'clubs'),
			card(3, 'hearts'),
			card(13, 'diamonds'),
			card(12, 'hearts'),
		];

		expect(getArrangementError(cards, [5, 6])).toBeNull();
		expect(getArrangement(cards, [5, 6])).not.toBeNull();
	});

	test('allows a pair High against a same-prefix pair Low', () => {
		const cards = [
			card(9, 'hearts'),
			card(9, 'spades'),
			card(13, 'diamonds'),
			card(7, 'clubs'),
			card(3, 'hearts'),
			card(9, 'diamonds'),
			card(9, 'clubs'),
		];

		expect(getArrangementError(cards, [5, 6])).toBeNull();
	});

	test('rejects an arrangement where Low outranks High', () => {
		const cards = [
			card(2, 'hearts'),
			card(3, 'diamonds'),
			card(4, 'clubs'),
			card(5, 'spades'),
			card(7, 'hearts'),
			card(14, 'diamonds'),
			card(13, 'clubs'),
		];

		expect(getArrangementError(cards, [5, 6])).toBe('high-hand-rank');
		expect(getArrangement(cards, [5, 6])).toBeNull();
	});

	test('validates the dealt card and Low index shape', () => {
		const cards = [card(2, 'hearts'), card(3, 'diamonds')];
		expect(getArrangementError(cards, [0, 1])).toBe('exactly-seven-cards');

		const sevenCards = [
			card(2, 'hearts'),
			card(3, 'diamonds'),
			card(4, 'clubs'),
			card(5, 'spades'),
			card(6, 'hearts'),
			card(7, 'diamonds'),
			card(8, 'clubs'),
		];
		expect(getArrangementError(sevenCards, [0])).toBe('exactly-two-low-indexes');
		expect(getArrangementError(sevenCards, [0, 0])).toBe('distinct-indexes');
		expect(getArrangementError(sevenCards, [0, 7])).toBe('indexes-in-range');
		expect(getArrangementError(sevenCards, [0, 1.5])).toBe('whole-number-indexes');
		expect(getArrangementError(sevenCards, [0.5, 1])).toBe('whole-number-indexes');
	});
});

describe('Pai Gow round resolution', () => {
	test('pays a win with five percent rounded-up commission', () => {
		const player = arrangement(
			{ category: 'high-card', tieBreakers: [14] },
			{ category: 'high-card', tieBreakers: [13] },
		);
		const dealer = arrangement(
			{ category: 'high-card', tieBreakers: [13] },
			{ category: 'high-card', tieBreakers: [12] },
		);

		expect(resolvePaiGowRound(player, dealer, 20)).toMatchObject({
			outcome: 'win',
			wager: 20,
			commission: 1,
			grossPayout: 39,
			netDelta: 19,
		});
	});

	test('returns the wager on a push', () => {
		const player = arrangement(
			{ category: 'high-card', tieBreakers: [14] },
			{ category: 'high-card', tieBreakers: [12] },
		);
		const dealer = arrangement(
			{ category: 'high-card', tieBreakers: [13] },
			{ category: 'high-card', tieBreakers: [13] },
		);

		expect(resolvePaiGowRound(player, dealer, 20)).toMatchObject({
			outcome: 'push',
			wager: 20,
			commission: 0,
			grossPayout: 20,
			netDelta: 0,
		});
	});

	test('loses the wager when neither hand wins', () => {
		const player = arrangement(
			{ category: 'high-card', tieBreakers: [12] },
			{ category: 'high-card', tieBreakers: [11] },
		);
		const dealer = arrangement(
			{ category: 'high-card', tieBreakers: [13] },
			{ category: 'high-card', tieBreakers: [14] },
		);

		expect(resolvePaiGowRound(player, dealer, 20)).toMatchObject({
			outcome: 'loss',
			wager: 20,
			commission: 0,
			grossPayout: 0,
			netDelta: -20,
		});
	});

	test('rounds a non-multiple commission up to the next chip', () => {
		const player = arrangement(
			{ category: 'high-card', tieBreakers: [14] },
			{ category: 'high-card', tieBreakers: [13] },
		);
		const dealer = arrangement(
			{ category: 'high-card', tieBreakers: [12] },
			{ category: 'high-card', tieBreakers: [11] },
		);

		expect(resolvePaiGowRound(player, dealer, 25)).toMatchObject({
			commission: 2,
			grossPayout: 48,
			netDelta: 23,
		});
	});

	test('charges the minimum one-chip commission on the minimum wager', () => {
		const player = arrangement(
			{ category: 'high-card', tieBreakers: [14] },
			{ category: 'high-card', tieBreakers: [13] },
		);
		const dealer = arrangement(
			{ category: 'high-card', tieBreakers: [12] },
			{ category: 'high-card', tieBreakers: [11] },
		);

		expect(resolvePaiGowRound(player, dealer, 5)).toMatchObject({
			outcome: 'win',
			wager: 5,
			commission: 1,
			grossPayout: 9,
			netDelta: 4,
		});
	});
});
