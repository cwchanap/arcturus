import type { Card } from '../cards';
import type {
	ThreeCardHandCategory,
	ThreeCardHandEvaluation,
	ThreeCardShowdownRoundResult,
} from './types';

const CATEGORY_STRENGTH: Record<ThreeCardHandCategory, number> = {
	'high-card': 0,
	pair: 1,
	flush: 2,
	straight: 3,
	'three-of-kind': 4,
	'straight-flush': 5,
};

const CATEGORY_LABEL: Record<ThreeCardHandCategory, string> = {
	'high-card': 'High Card',
	pair: 'Pair',
	flush: 'Flush',
	straight: 'Straight',
	'three-of-kind': 'Three of a Kind',
	'straight-flush': 'Straight Flush',
};

function sortedRanks(cards: readonly Card[]): number[] {
	return cards.map((card) => card.rank).sort((a, b) => b - a);
}

export function evaluateThreeCardHand(cards: readonly Card[]): ThreeCardHandEvaluation {
	const ranks = sortedRanks(cards);
	const [high, middle, low] = ranks;

	const isFlush = cards.every((card) => card.suit === cards[0].suit);
	const isAceLowStraight = high === 14 && middle === 3 && low === 2;
	const isStraight = (high - middle === 1 && middle - low === 1) || isAceLowStraight;

	const tieBreakers = isAceLowStraight ? [3, 2, 1] : ranks;

	let category: ThreeCardHandCategory;
	if (high === low) {
		category = 'three-of-kind';
	} else if (isFlush && isStraight) {
		category = 'straight-flush';
	} else if (isStraight) {
		category = 'straight';
	} else if (isFlush) {
		category = 'flush';
	} else if (high === middle || middle === low) {
		category = 'pair';
	} else {
		category = 'high-card';
	}

	let tieBreakRanks: readonly number[];
	if (category === 'pair') {
		const pairRank = high === middle ? high : middle;
		const kicker = high === middle ? low : high;
		tieBreakRanks = [pairRank, kicker];
	} else if (category === 'three-of-kind') {
		tieBreakRanks = [high];
	} else {
		tieBreakRanks = tieBreakers;
	}

	return { category, label: CATEGORY_LABEL[category], tieBreakers: tieBreakRanks };
}

export function compareThreeCardHands(
	left: ThreeCardHandEvaluation,
	right: ThreeCardHandEvaluation,
): -1 | 0 | 1 {
	const strengthDiff = CATEGORY_STRENGTH[left.category] - CATEGORY_STRENGTH[right.category];
	if (strengthDiff !== 0) return strengthDiff > 0 ? 1 : -1;

	for (let i = 0; i < left.tieBreakers.length; i++) {
		const diff = left.tieBreakers[i] - right.tieBreakers[i];
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

export function dealerQualifies(evaluation: ThreeCardHandEvaluation): boolean {
	if (evaluation.category !== 'high-card') return true;
	return evaluation.tieBreakers[0] >= 12;
}

export function resolvePlayedHand(
	playerCards: readonly Card[],
	dealerCards: readonly Card[],
	ante: number,
): ThreeCardShowdownRoundResult {
	const playerEvaluation = evaluateThreeCardHand(playerCards);
	const dealerEvaluation = evaluateThreeCardHand(dealerCards);

	const totalWager = ante * 2;
	const qualified = dealerQualifies(dealerEvaluation);

	let outcome: ThreeCardShowdownRoundResult['outcome'];
	let grossPayout: number;
	if (!qualified) {
		outcome = 'dealer-not-qualified';
		grossPayout = ante * 3;
	} else {
		const comparison = compareThreeCardHands(playerEvaluation, dealerEvaluation);
		if (comparison > 0) {
			outcome = 'player-win';
			grossPayout = ante * 4;
		} else if (comparison === 0) {
			outcome = 'tie';
			grossPayout = ante * 2;
		} else {
			outcome = 'dealer-win';
			grossPayout = 0;
		}
	}

	const result: ThreeCardShowdownRoundResult = {
		outcome,
		ante,
		totalWager,
		grossPayout,
		netDelta: grossPayout - totalWager,
		dealerQualified: qualified,
		playerHand: Object.freeze([...playerCards]),
		dealerHand: Object.freeze([...dealerCards]),
		playerEvaluation: Object.freeze(playerEvaluation),
		dealerEvaluation: Object.freeze(dealerEvaluation),
	};
	return Object.freeze(result);
}
