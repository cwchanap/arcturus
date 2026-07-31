import { z } from 'zod';
import { GAME_TYPES } from './game-stats/constants';
import type { PlayerStatisticsDashboard } from './game-stats/player-statistics-types';

const safeInteger = z.number().refine(Number.isSafeInteger, 'Expected a safe integer');
const nonNegativeSafeInteger = safeInteger.refine((value) => value >= 0, 'Expected >= 0');
const percentage = z.number().finite().min(0).max(100);
const gameType = z.enum(GAME_TYPES);

const summarySchema = z
	.object({
		totalHands: nonNegativeSafeInteger,
		totalWins: nonNegativeSafeInteger,
		totalLosses: nonNegativeSafeInteger,
		overallWinRate: percentage,
		totalNetProfit: safeInteger,
		mostPlayedGame: gameType.nullable(),
	})
	.strict();

const gameSchema = z
	.object({
		gameType,
		totalWins: nonNegativeSafeInteger,
		totalLosses: nonNegativeSafeInteger,
		handsPlayed: nonNegativeSafeInteger,
		winRate: percentage,
		netProfit: safeInteger,
		biggestWin: nonNegativeSafeInteger,
		winsRank: safeInteger.refine((value) => value > 0).nullable(),
	})
	.strict();

const dashboardSchema = z
	.object({ summary: summarySchema, games: z.array(gameSchema) })
	.strict()
	.superRefine((dashboard, context) => {
		if (dashboard.games.length !== GAME_TYPES.length) {
			context.addIssue({ code: 'custom', message: 'Expected every canonical game' });
			return;
		}

		for (const [index, expected] of GAME_TYPES.entries()) {
			const game = dashboard.games[index];
			if (game?.gameType !== expected) {
				context.addIssue({ code: 'custom', message: 'Games must use canonical order' });
			}
			if (game?.handsPlayed === 0 && game.winsRank !== null) {
				context.addIssue({ code: 'custom', message: 'Zero-hand games must be unranked' });
			}
		}
	});

export function parsePlayerStatisticsDashboard(value: unknown): PlayerStatisticsDashboard {
	return dashboardSchema.parse(value) as PlayerStatisticsDashboard;
}
