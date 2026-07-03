import type { Card } from './types';
import { clamp } from './aiMath';

export type BoardTextureKind = 'none' | 'dry' | 'semi-wet' | 'wet';

export interface BoardTexture {
	kind: BoardTextureKind;
	paired: boolean;
	monotone: boolean;
	twoTone: boolean;
	flushDrawPossible: boolean;
	straightDrawPossible: boolean;
	highCardCount: number;
	connectedness: number;
	pressure: number;
	tags: string[];
}

function hasStraightPressure(ranks: number[]): boolean {
	const uniqueRanks = [...new Set(ranks.flatMap((rank) => (rank === 14 ? [14, 1] : [rank])))].sort(
		(a, b) => a - b,
	);

	for (let i = 0; i < uniqueRanks.length; i++) {
		const window = uniqueRanks.slice(i, i + 4);
		if (window.length >= 3 && window[window.length - 1] - window[0] <= 4) {
			return true;
		}
	}

	return false;
}

export function classifyBoardTexture(communityCards: Card[]): BoardTexture {
	if (communityCards.length < 3) {
		return {
			kind: 'none',
			paired: false,
			monotone: false,
			twoTone: false,
			flushDrawPossible: false,
			straightDrawPossible: false,
			highCardCount: 0,
			connectedness: 0,
			pressure: 0,
			tags: ['preflop'],
		};
	}

	const ranks = communityCards.map((card) => card.rank);
	const rankCounts = new Map<number, number>();
	const suitCounts = new Map<Card['suit'], number>();

	for (const card of communityCards) {
		rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
		suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
	}

	const maxSuitCount = Math.max(...suitCounts.values());
	const paired = [...rankCounts.values()].some((count) => count >= 2);
	const monotone = maxSuitCount >= 3;
	const twoTone = maxSuitCount === 2;
	const flushDrawPossible = maxSuitCount >= 2;
	const straightDrawPossible = hasStraightPressure(ranks);
	const highCardCount = ranks.filter((rank) => rank >= 11).length;
	const sortedRanks = [...new Set(ranks)].sort((a, b) => a - b);
	const connectedness =
		sortedRanks.length < 2
			? 0
			: clamp(1 - (sortedRanks[sortedRanks.length - 1] - sortedRanks[0]) / 12, 0, 1);

	const tags: string[] = [];
	if (paired) tags.push('paired');
	if (monotone) tags.push('monotone');
	if (!monotone && twoTone) tags.push('two-tone');
	if (straightDrawPossible) tags.push('straight-pressure');
	if (highCardCount >= 2) tags.push('high-card-heavy');

	let pressure = 0.12;
	if (paired) pressure += 0.12;
	if (twoTone) pressure += 0.18;
	// Monotone boards already enable a made flush / flush draw and are inherently
	// wet. A bare monotone flop (e.g. 2♠-5♠-8♠) still lands in 'wet' territory,
	// and an Ace- or King-high monotone board (e.g. A♠-8♠-3♠) carries a nut-flush
	// threat that demands an extra boost so it never drops below 'wet'.
	if (monotone) pressure += 0.45;
	if (monotone && highCardCount >= 1) pressure += 0.1;
	if (straightDrawPossible) pressure += 0.25;
	if (highCardCount >= 2) pressure += 0.08;
	pressure += connectedness * 0.15;
	pressure = clamp(pressure, 0, 1);

	const kind: BoardTextureKind = pressure >= 0.55 ? 'wet' : pressure >= 0.35 ? 'semi-wet' : 'dry';

	return {
		kind,
		paired,
		monotone,
		twoTone,
		flushDrawPossible,
		straightDrawPossible,
		highCardCount,
		connectedness,
		pressure,
		tags,
	};
}
