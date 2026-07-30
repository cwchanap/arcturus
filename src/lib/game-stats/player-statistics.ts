import { aggregateGameStats, calculateWinRate } from './aggregation';
import { GAME_TYPES, isValidGameType } from './constants';
import type { GameType } from './types';
import type {
	PlayerGameStatistics,
	PlayerStatisticsDashboard,
	PlayerStatisticsSourceRow,
	PlayerStatisticsSummary,
} from './player-statistics-types';

export class PlayerStatisticsIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlayerStatisticsIntegrityError';
	}
}

const EMPTY_TOTALS = {
	totalWins: 0,
	totalLosses: 0,
	handsPlayed: 0,
	biggestWin: 0,
	netProfit: 0,
} as const;

function buildSummary(games: readonly PlayerGameStatistics[]): PlayerStatisticsSummary {
	const aggregate = aggregateGameStats(games);
	const mostPlayedGame = games.reduce<GameType | null>((current, game) => {
		if (game.handsPlayed === 0) return current;
		if (current === null) return game.gameType;
		const currentHands = games.find((entry) => entry.gameType === current)?.handsPlayed ?? 0;
		return game.handsPlayed > currentHands ? game.gameType : current;
	}, null);

	return {
		totalHands: aggregate.totalHandsPlayed,
		totalWins: aggregate.totalWins,
		totalLosses: aggregate.totalLosses,
		overallWinRate: calculateWinRate(aggregate.totalWins, aggregate.totalLosses),
		totalNetProfit: aggregate.totalNetProfit,
		mostPlayedGame,
	};
}

export function buildPlayerStatisticsDashboard(
	rows: readonly PlayerStatisticsSourceRow[],
	winsRanks: ReadonlyMap<GameType, number> = new Map(),
): PlayerStatisticsDashboard {
	const byGame = new Map<GameType, PlayerStatisticsSourceRow>();
	for (const row of rows) {
		if (!isValidGameType(row.gameType)) {
			console.warn('[PLAYER_STATISTICS] Ignoring unsupported game type');
			continue;
		}
		if (byGame.has(row.gameType)) {
			throw new PlayerStatisticsIntegrityError(`Duplicate statistics row for ${row.gameType}`);
		}
		byGame.set(row.gameType, row);
	}

	const games = GAME_TYPES.map<PlayerGameStatistics>((gameType) => {
		const row = byGame.get(gameType) ?? EMPTY_TOTALS;
		return {
			gameType,
			totalWins: row.totalWins,
			totalLosses: row.totalLosses,
			handsPlayed: row.handsPlayed,
			winRate: calculateWinRate(row.totalWins, row.totalLosses),
			netProfit: row.netProfit,
			biggestWin: row.biggestWin,
			winsRank: row.handsPlayed > 0 ? (winsRanks.get(gameType) ?? null) : null,
		};
	});

	return { summary: buildSummary(games), games };
}
