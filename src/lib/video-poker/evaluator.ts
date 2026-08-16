import type { Card } from '../cards';
import type { HandCategory, HandEvaluation } from './types';

const LABELS: Readonly<Record<HandCategory, string>> = {
	'royal-flush': 'Royal Flush',
	'straight-flush': 'Straight Flush',
	'four-of-kind': 'Four of a Kind',
	'full-house': 'Full House',
	flush: 'Flush',
	straight: 'Straight',
	'three-of-kind': 'Three of a Kind',
	'two-pair': 'Two Pair',
	'jacks-or-better': 'Jacks or Better',
	nothing: 'No Win',
};

const out = (category: HandCategory): HandEvaluation => ({ category, label: LABELS[category] });

export function evaluateHand(cards: readonly Card[]): HandEvaluation {
	if (cards.length !== 5) {
		throw new RangeError('Video Poker hands must contain exactly five cards');
	}

	const ranks = cards.map((card) => card.rank);
	const unique = [...new Set(ranks)].sort((a, b) => a - b);
	const countsByRank = new Map<number, number>();
	for (const rank of ranks) countsByRank.set(rank, (countsByRank.get(rank) ?? 0) + 1);

	const counts = [...countsByRank.values()].sort((a, b) => b - a);
	const pairRanks = [...countsByRank.entries()]
		.filter(([, count]) => count === 2)
		.map(([rank]) => rank);
	const flush = new Set(cards.map((card) => card.suit)).size === 1;
	const wheel = unique.join(',') === '2,3,4,5,14';
	const consecutive = unique.length === 5 && unique[4] - unique[0] === 4;
	const straight = wheel || consecutive;
	const royal = unique.join(',') === '10,11,12,13,14';

	if (flush && straight && royal) return out('royal-flush');
	if (flush && straight) return out('straight-flush');
	if (counts[0] === 4) return out('four-of-kind');
	if (counts[0] === 3 && counts[1] === 2) return out('full-house');
	if (flush) return out('flush');
	if (straight) return out('straight');
	if (counts[0] === 3) return out('three-of-kind');
	if (pairRanks.length === 2) return out('two-pair');
	if (pairRanks.length === 1 && pairRanks[0] >= 11) return out('jacks-or-better');
	return out('nothing');
}
