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

	// A connected 3-rank cluster within a 4-wide span (e.g. 2-3-4 on a
	// 2-3-4-K board) already creates straight pressure even when an unrelated
	// high card sits elsewhere on the board — a fixed 4-card slice would span
	// to the high card and miss it. The 3-rank window is sufficient on its own:
	// any 4-rank window with span ≤ 4 has a 3-rank prefix with span ≤ 4 too, so
	// a separate 4-rank check would be unreachable.
	for (let i = 0; i < uniqueRanks.length; i++) {
		const window3 = uniqueRanks.slice(i, i + 3);
		if (window3.length === 3 && window3[window3.length - 1] - window3[0] <= 4) {
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
	// "Monotone" is strictly a flop term: all three cards the same suit. On
	// turn/river a 3+ same-suit cluster is a flush draw / made flush, not a
	// monotone board, so the public label is gated to the 3-card case.
	const monotone = communityCards.length === 3 && maxSuitCount === 3;
	const twoTone = maxSuitCount === 2;
	// Internal pressure flag: any 3+ same-suit cluster drives flush pressure on
	// every street (monotone flop, turn/river flush draw, or a board flush).
	// Kept separate from the `monotone` label so flop-only semantics hold without
	// dampening later-street flush pressure.
	const flushBoard = maxSuitCount >= 3;
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
	if (!monotone && flushBoard) tags.push('flush-draw');
	if (!monotone && twoTone) tags.push('two-tone');
	if (straightDrawPossible) tags.push('straight-pressure');
	if (highCardCount >= 2) tags.push('high-card-heavy');

	let pressure = 0.12;
	if (paired) pressure += 0.12;
	if (twoTone) pressure += 0.18;
	// A 3+ same-suit cluster (monotone flop or turn/river flush draw) already
	// enables a made flush / flush draw and is inherently wet. A bare monotone
	// flop (e.g. 2♠-5♠-8♠) still lands in 'wet' territory, and an Ace- or
	// King-high monotone board (e.g. A♠-8♠-3♠) carries a nut-flush threat that
	// demands an extra boost so it never drops below 'wet'.
	if (flushBoard) pressure += 0.45;
	if (flushBoard && highCardCount >= 1) pressure += 0.1;
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
