import type { GameStats } from './types';

export type AggregatableGameStats = Pick<
	GameStats,
	'totalWins' | 'totalLosses' | 'handsPlayed' | 'biggestWin' | 'netProfit'
>;

export interface GameStatsAggregate {
	totalWins: number;
	totalLosses: number;
	totalHandsPlayed: number;
	biggestWin: number;
	totalNetProfit: number;
}

export function calculateWinRate(totalWins: number, totalLosses: number): number {
	const decidedHands = totalWins + totalLosses;
	return decidedHands > 0 ? (totalWins / decidedHands) * 100 : 0;
}

export function aggregateGameStats(stats: readonly AggregatableGameStats[]): GameStatsAggregate {
	return stats.reduce<GameStatsAggregate>(
		(aggregate, row) => ({
			totalWins: aggregate.totalWins + row.totalWins,
			totalLosses: aggregate.totalLosses + row.totalLosses,
			totalHandsPlayed: aggregate.totalHandsPlayed + row.handsPlayed,
			biggestWin: Math.max(aggregate.biggestWin, row.biggestWin),
			totalNetProfit: aggregate.totalNetProfit + row.netProfit,
		}),
		{
			totalWins: 0,
			totalLosses: 0,
			totalHandsPlayed: 0,
			biggestWin: 0,
			totalNetProfit: 0,
		},
	);
}
