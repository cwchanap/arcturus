import { comparePaiGowRankings, getArrangement } from './rules';
import type {
	LowHandIndexes,
	PaiGowArrangement,
	PaiGowCard,
	PaiGowCategory,
	PaiGowHandRanking,
} from './types';

const PROTECTED_HIGH = new Set<PaiGowCategory>([
	'straight',
	'flush',
	'straight-flush',
	'royal-flush',
]);

function compareLowIndexes(left: LowHandIndexes, right: LowHandIndexes): -1 | 0 | 1 {
	if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
	if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
	return 0;
}

function isBetterArrangement(candidate: PaiGowArrangement, current: PaiGowArrangement): boolean {
	const lowComparison = comparePaiGowRankings(candidate.lowRanking, current.lowRanking);
	if (lowComparison !== 0) return lowComparison > 0;

	const highComparison = comparePaiGowRankings(candidate.highRanking, current.highRanking);
	if (highComparison !== 0) return highComparison > 0;

	return compareLowIndexes(candidate.lowIndexes, current.lowIndexes) < 0;
}

export function arrangeHouseWay(cards: readonly PaiGowCard[]): PaiGowArrangement {
	const lowPairs: Array<readonly [number, number]> = [];
	for (let left = 0; left < 6; left += 1) {
		for (let right = left + 1; right < 7; right += 1) {
			lowPairs.push([left, right]);
		}
	}

	const valid = lowPairs
		.map((pair) => getArrangement(cards, pair))
		.filter((arrangement): arrangement is PaiGowArrangement => arrangement !== null);
	if (valid.length === 0) throw new Error('No valid Pai Gow arrangement');

	let bestProtected: PaiGowHandRanking | null = null;
	for (const arrangement of valid) {
		if (!PROTECTED_HIGH.has(arrangement.highRanking.category)) continue;
		if (!bestProtected || comparePaiGowRankings(arrangement.highRanking, bestProtected) > 0) {
			bestProtected = arrangement.highRanking;
		}
	}

	const candidates = bestProtected
		? valid.filter(
				(arrangement) => comparePaiGowRankings(arrangement.highRanking, bestProtected) === 0,
			)
		: valid;
	let best = candidates[0]!;
	for (const candidate of candidates.slice(1)) {
		if (isBetterArrangement(candidate, best)) best = candidate;
	}
	return best;
}
