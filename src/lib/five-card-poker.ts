export interface FiveCardRankable {
	rank: number;
	suit: string;
}

export type FiveCardCategory =
	| 'straight-flush'
	| 'four-of-kind'
	| 'full-house'
	| 'flush'
	| 'straight'
	| 'three-of-kind'
	| 'two-pair'
	| 'pair'
	| 'high-card';

export interface FiveCardRanking {
	category: FiveCardCategory;
	tieBreakers: number[];
}

const CATEGORY_STRENGTH: Record<FiveCardCategory, number> = {
	'high-card': 1,
	pair: 2,
	'two-pair': 3,
	'three-of-kind': 4,
	straight: 5,
	flush: 6,
	'full-house': 7,
	'four-of-kind': 8,
	'straight-flush': 9,
};

export function rankFiveCardHand(cards: readonly FiveCardRankable[]): FiveCardRanking {
	if (cards.length !== 5) {
		throw new Error('rankFiveCardHand requires exactly 5 cards');
	}

	const rankCounts = new Map<number, number>();
	const suitCounts = new Map<string, number>();
	for (const card of cards) {
		rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
		suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
	}

	const ranks = [...rankCounts.keys()].sort((a, b) => b - a);
	const isFlush = [...suitCounts.values()].some((count) => count === 5);
	let straightHigh: number | undefined;
	if (ranks.length === 5) {
		if (ranks[0] - ranks[4] === 4) {
			straightHigh = ranks[0];
		} else if (ranks.join(',') === '14,5,4,3,2') {
			straightHigh = 5;
		}
	}

	if (isFlush && straightHigh !== undefined) {
		return { category: 'straight-flush', tieBreakers: [straightHigh] };
	}

	const groups = new Map<number, number[]>();
	for (const [rank, count] of rankCounts) {
		const group = groups.get(count) ?? [];
		group.push(rank);
		groups.set(count, group);
	}
	for (const group of groups.values()) {
		group.sort((a, b) => b - a);
	}

	if (groups.has(4)) {
		return {
			category: 'four-of-kind',
			tieBreakers: [groups.get(4)![0], groups.get(1)![0]],
		};
	}

	if (groups.has(3) && groups.has(2)) {
		return {
			category: 'full-house',
			tieBreakers: [groups.get(3)![0], groups.get(2)![0]],
		};
	}

	if (isFlush) {
		return { category: 'flush', tieBreakers: ranks };
	}

	if (straightHigh !== undefined) {
		return { category: 'straight', tieBreakers: [straightHigh] };
	}

	if (groups.has(3)) {
		return {
			category: 'three-of-kind',
			tieBreakers: [groups.get(3)![0], ...(groups.get(1) ?? [])],
		};
	}

	if (groups.get(2)?.length === 2) {
		return {
			category: 'two-pair',
			tieBreakers: [...groups.get(2)!, ...(groups.get(1) ?? [])],
		};
	}

	if (groups.has(2)) {
		return {
			category: 'pair',
			tieBreakers: [groups.get(2)![0], ...(groups.get(1) ?? [])],
		};
	}

	return { category: 'high-card', tieBreakers: ranks };
}

export function compareFiveCardRankings(left: FiveCardRanking, right: FiveCardRanking): -1 | 0 | 1 {
	const strengthDifference = CATEGORY_STRENGTH[left.category] - CATEGORY_STRENGTH[right.category];
	if (strengthDifference !== 0) return strengthDifference > 0 ? 1 : -1;

	for (let i = 0; i < Math.max(left.tieBreakers.length, right.tieBreakers.length); i++) {
		const leftValue = left.tieBreakers[i] ?? 0;
		const rightValue = right.tieBreakers[i] ?? 0;
		if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
	}

	return 0;
}
