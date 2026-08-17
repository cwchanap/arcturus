import type { Card } from '../cards';
import { createDeck } from '../cards';
import { rankFiveCardHand, type FiveCardRanking } from '../five-card-poker';
import { isPaiGowJoker } from './cards';
import type {
	LowHandIndexes,
	PaiGowArrangement,
	PaiGowCard,
	PaiGowCategory,
	PaiGowHandRanking,
	PaiGowRoundOutcome,
	PaiGowRoundResult,
} from './types';

const CATEGORY_STRENGTH: Record<PaiGowCategory, number> = {
	'high-card': 1,
	pair: 2,
	'two-pair': 3,
	'three-of-kind': 4,
	straight: 5,
	flush: 6,
	'full-house': 7,
	'four-of-kind': 8,
	'straight-flush': 9,
	'royal-flush': 10,
	'five-aces': 11,
};

const SPECIAL_JOKER_CATEGORIES: readonly PaiGowCategory[] = [
	'straight',
	'flush',
	'straight-flush',
	'royal-flush',
];

function normalizeFiveCardRanking(ranking: FiveCardRanking): PaiGowHandRanking {
	switch (ranking.category) {
		case 'straight': {
			const high = ranking.tieBreakers[0]!;
			return {
				category: 'straight',
				tieBreakers: [high === 14 ? 15 : high === 5 ? 14 : high],
			};
		}
		case 'straight-flush': {
			const high = ranking.tieBreakers[0]!;
			if (high === 14) return { category: 'royal-flush', tieBreakers: [] };
			return {
				category: 'straight-flush',
				tieBreakers: [high === 5 ? 14 : high],
			};
		}
		default:
			return {
				category: ranking.category,
				tieBreakers: [...ranking.tieBreakers],
			};
	}
}

export function comparePaiGowRankings(
	left: PaiGowHandRanking,
	right: PaiGowHandRanking,
): -1 | 0 | 1 {
	const categoryDiff = CATEGORY_STRENGTH[left.category] - CATEGORY_STRENGTH[right.category];
	if (categoryDiff !== 0) return categoryDiff > 0 ? 1 : -1;

	const sharedLength = Math.min(left.tieBreakers.length, right.tieBreakers.length);
	for (let i = 0; i < sharedLength; i += 1) {
		const diff = left.tieBreakers[i] - right.tieBreakers[i];
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}

	if (left.tieBreakers.length === right.tieBreakers.length) return 0;
	return left.tieBreakers.length > right.tieBreakers.length ? 1 : -1;
}

function rankPaiGowFiveCardHandWithoutJoker(cards: readonly Card[]): PaiGowHandRanking {
	return normalizeFiveCardRanking(rankFiveCardHand(cards));
}

function rankPaiGowFiveCardHandWithJoker(cards: readonly PaiGowCard[]): PaiGowHandRanking {
	const naturalCards = cards.filter((card): card is Card => !isPaiGowJoker(card));
	if (naturalCards.filter((card) => card.rank === 14).length === 4) {
		return { category: 'five-aces', tieBreakers: [] };
	}

	let bestRanking: PaiGowHandRanking | undefined;
	for (const replacement of createDeck()) {
		const isDuplicate = naturalCards.some(
			(card) => card.rank === replacement.rank && card.suit === replacement.suit,
		);
		if (isDuplicate) continue;

		const ranking = rankPaiGowFiveCardHandWithoutJoker([...naturalCards, replacement]);
		if (replacement.rank !== 14 && !SPECIAL_JOKER_CATEGORIES.includes(ranking.category)) {
			continue;
		}
		if (!bestRanking || comparePaiGowRankings(ranking, bestRanking) > 0) {
			bestRanking = ranking;
		}
	}

	return bestRanking!;
}

export function rankPaiGowFiveCardHand(cards: readonly PaiGowCard[]): PaiGowHandRanking {
	if (cards.length !== 5) {
		throw new Error('rankPaiGowFiveCardHand requires exactly 5 cards');
	}

	const jokerCount = cards.filter(isPaiGowJoker).length;
	if (jokerCount > 1) {
		throw new Error('rankPaiGowFiveCardHand supports at most one Joker');
	}
	if (jokerCount === 0) {
		const naturalCards = cards.filter((card): card is Card => !isPaiGowJoker(card));
		return rankPaiGowFiveCardHandWithoutJoker(naturalCards);
	}
	return rankPaiGowFiveCardHandWithJoker(cards);
}

export function rankPaiGowTwoCardHand(cards: readonly PaiGowCard[]): PaiGowHandRanking {
	if (cards.length !== 2) {
		throw new Error('rankPaiGowTwoCardHand requires exactly 2 cards');
	}

	const ranks = cards
		.map((card) => (isPaiGowJoker(card) ? 14 : card.rank))
		.sort((left, right) => right - left);
	if (ranks[0] === ranks[1]) {
		return { category: 'pair', tieBreakers: [ranks[0]!] };
	}
	return { category: 'high-card', tieBreakers: ranks };
}

function splitArrangementCards(
	cards: readonly PaiGowCard[],
	lowIndexes: LowHandIndexes,
): { high: PaiGowCard[]; low: PaiGowCard[] } {
	const [firstIndex, secondIndex] = lowIndexes;
	return {
		high: cards.filter((_, index) => index !== firstIndex && index !== secondIndex),
		low: [cards[firstIndex]!, cards[secondIndex]!],
	};
}

export function getArrangementError(
	cards: readonly PaiGowCard[],
	lowIndexes: readonly number[],
): string | null {
	if (cards.length !== 7) return 'Exactly seven cards are required';
	if (lowIndexes.length !== 2) return 'Exactly two low-hand indexes are required';

	const firstIndex = lowIndexes[0]!;
	const secondIndex = lowIndexes[1]!;
	if (firstIndex === secondIndex) return 'Low-hand indexes must be distinct';
	if (firstIndex < 0 || firstIndex > 6 || secondIndex < 0 || secondIndex > 6) {
		return 'Low-hand indexes must be between 0 and 6';
	}

	const indexes: LowHandIndexes = [firstIndex, secondIndex];
	const { high, low } = splitArrangementCards(cards, indexes);
	const highRanking = rankPaiGowFiveCardHand(high);
	const lowRanking = rankPaiGowTwoCardHand(low);
	if (comparePaiGowRankings(highRanking, lowRanking) < 0) {
		return 'High hand must rank at least as high as Low hand';
	}
	return null;
}

export function getArrangement(
	cards: readonly PaiGowCard[],
	lowIndexes: readonly number[],
): PaiGowArrangement | null {
	if (getArrangementError(cards, lowIndexes)) return null;

	const indexes: LowHandIndexes = [lowIndexes[0]!, lowIndexes[1]!];
	const { high, low } = splitArrangementCards(cards, indexes);
	return {
		lowIndexes: indexes,
		high,
		low,
		highRanking: rankPaiGowFiveCardHand(high),
		lowRanking: rankPaiGowTwoCardHand(low),
	};
}

export function resolvePaiGowRound(
	player: PaiGowArrangement,
	dealer: PaiGowArrangement,
	wager: number,
): PaiGowRoundResult {
	const wonHigh = comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
	const wonLow = comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;

	const outcome: PaiGowRoundOutcome =
		wonHigh && wonLow ? 'win' : wonHigh || wonLow ? 'push' : 'loss';

	const commission = outcome === 'win' ? Math.ceil(wager * 0.05) : 0;
	const grossPayout = outcome === 'win' ? wager * 2 - commission : outcome === 'push' ? wager : 0;

	return {
		outcome,
		wager,
		commission,
		grossPayout,
		netDelta: grossPayout - wager,
		player,
		dealer,
	};
}
