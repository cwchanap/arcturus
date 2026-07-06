import { NUM_PAYLINES, PAYLINES, PAYTABLE } from './constants';
import type { LineWin, ReelGrid, SpinEvaluation, SymbolId } from './types';

export function evaluateLine(
	line: SymbolId[],
): { symbol: SymbolId; count: 3 | 4 | 5; multiplier: number } | null {
	if (line.length < 3) return null;
	const first = line[0];
	let count = 1;
	for (let i = 1; i < line.length; i++) {
		if (line[i] === first) count++;
		else break;
	}
	if (count < 3) return null;
	const tier = PAYTABLE[first];
	const key = (count > 5 ? 5 : count) as 3 | 4 | 5;
	return { symbol: first, count: key, multiplier: tier[key] };
}

export function linePayout(multiplier: number, totalBet: number): number {
	return Math.round((multiplier * totalBet) / NUM_PAYLINES);
}

export function extractLine(grid: ReelGrid, payline: readonly number[]): SymbolId[] {
	return payline.map((row, reel) => grid[reel][row]);
}

export function evaluateGrid(grid: ReelGrid, totalBet: number): SpinEvaluation {
	const lineWins: LineWin[] = [];
	PAYLINES.forEach((payline, index) => {
		const line = extractLine(grid, payline);
		const match = evaluateLine(line);
		if (match) {
			lineWins.push({
				paylineIndex: index,
				symbol: match.symbol,
				count: match.count,
				multiplier: match.multiplier,
				payout: linePayout(match.multiplier, totalBet),
			});
		}
	});
	const totalPayout = lineWins.reduce((sum, w) => sum + w.payout, 0);
	return { grid, lineWins, totalPayout };
}
