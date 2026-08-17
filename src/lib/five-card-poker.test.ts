import { expect, test } from 'bun:test';
import { compareFiveCardRankings, rankFiveCardHand } from './five-card-poker';

const c = (rank: number, suit = 'spades') => ({ rank, suit });

test('standard unsuited wheel is below an unsuited 6-high straight', () => {
	const wheel = rankFiveCardHand([
		c(14, 'spades'),
		c(2, 'hearts'),
		c(3, 'clubs'),
		c(4, 'diamonds'),
		c(5, 'spades'),
	]);
	const sixHigh = rankFiveCardHand([
		c(2, 'spades'),
		c(3, 'hearts'),
		c(4, 'clubs'),
		c(5, 'diamonds'),
		c(6, 'spades'),
	]);

	expect(wheel).toEqual({ category: 'straight', tieBreakers: [5] });
	expect(sixHigh).toEqual({ category: 'straight', tieBreakers: [6] });
	expect(compareFiveCardRankings(wheel, sixHigh)).toBe(-1);
});

test('Broadway straight flush beats K-high without a Royal category', () => {
	const broadway = rankFiveCardHand([c(10), c(11), c(12), c(13), c(14)]);
	const kingHigh = rankFiveCardHand([c(9), c(10), c(11), c(12), c(13)]);

	expect(broadway).toEqual({ category: 'straight-flush', tieBreakers: [14] });
	expect(kingHigh).toEqual({ category: 'straight-flush', tieBreakers: [13] });
	expect(compareFiveCardRankings(broadway, kingHigh)).toBe(1);
});

test('full house compares trips before pair', () => {
	const kings = rankFiveCardHand([c(13), c(13), c(13), c(2), c(2)]);
	const queens = rankFiveCardHand([c(12), c(12), c(12), c(14), c(14)]);
	expect(compareFiveCardRankings(kings, queens)).toBe(1);
});

test('two pair compares kicker last', () => {
	const ace = rankFiveCardHand([c(10), c(10), c(8), c(8), c(14)]);
	const king = rankFiveCardHand([c(10), c(10), c(8), c(8), c(13)]);
	expect(compareFiveCardRankings(ace, king)).toBe(1);
});
