import type { GameStats, GameType } from './types';

export interface PlayerStatisticsSourceRow extends Omit<GameStats, 'gameType'> {
	gameType: string;
}

export interface PlayerStatisticsSummary {
	totalHands: number;
	totalWins: number;
	totalLosses: number;
	overallWinRate: number;
	totalNetProfit: number;
	mostPlayedGame: GameType | null;
}

export interface PlayerGameStatistics {
	gameType: GameType;
	totalWins: number;
	totalLosses: number;
	handsPlayed: number;
	winRate: number;
	netProfit: number;
	biggestWin: number;
	winsRank: number | null;
}

export interface PlayerStatisticsDashboard {
	summary: PlayerStatisticsSummary;
	games: PlayerGameStatistics[];
}
