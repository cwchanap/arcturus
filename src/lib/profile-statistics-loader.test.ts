import { describe, expect, test } from 'bun:test';
import type { Database } from './db';
import type { PlayerStatisticsSummary } from './game-stats/player-statistics-types';
import { loadProfileStatisticsState } from './profile-statistics-loader';

describe('loadProfileStatisticsState', () => {
	test('returns the injected summary as ready state', async () => {
		const summary: PlayerStatisticsSummary = {
			totalHands: 8,
			totalWins: 5,
			totalLosses: 3,
			overallWinRate: 62.5,
			totalNetProfit: 45,
			mostPlayedGame: 'poker',
		};

		await expect(
			loadProfileStatisticsState({} as Database, 'user-1', async () => summary),
		).resolves.toEqual({
			status: 'ready',
			summary,
		});
	});

	test('returns error state when the injected summary load rejects', async () => {
		const originalError = console.error;
		console.error = () => undefined;
		try {
			await expect(
				loadProfileStatisticsState({} as Database, 'user-1', async () => {
					throw new Error('database unavailable');
				}),
			).resolves.toEqual({ status: 'error' });
		} finally {
			console.error = originalError;
		}
	});
});
