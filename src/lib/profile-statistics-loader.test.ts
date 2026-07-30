import { describe, expect, test } from 'bun:test';
import type { Database } from './db';
import type { PlayerStatisticsSummary } from './game-stats/player-statistics-types';

type ProfileStatisticsState =
	| { status: 'ready'; summary: PlayerStatisticsSummary }
	| { status: 'error' };

type LoadProfileStatisticsState = (
	db: Database,
	userId: string,
	load?: (db: Database, userId: string) => Promise<PlayerStatisticsSummary>,
) => Promise<ProfileStatisticsState>;

async function loadProfileStatisticsState(): Promise<LoadProfileStatisticsState | undefined> {
	try {
		const module = (await import('./profile-statistics-loader')) as {
			loadProfileStatisticsState?: LoadProfileStatisticsState;
		};
		return module.loadProfileStatisticsState;
	} catch {
		return undefined;
	}
}

describe('loadProfileStatisticsState', () => {
	test('returns the injected summary as ready state', async () => {
		const load = await loadProfileStatisticsState();
		expect(typeof load).toBe('function');
		if (!load) return;

		const summary: PlayerStatisticsSummary = {
			totalHands: 8,
			totalWins: 5,
			totalLosses: 3,
			overallWinRate: 62.5,
			totalNetProfit: 45,
			mostPlayedGame: 'poker',
		};

		await expect(load({} as Database, 'user-1', async () => summary)).resolves.toEqual({
			status: 'ready',
			summary,
		});
	});

	test('returns error state when the injected summary load rejects', async () => {
		const load = await loadProfileStatisticsState();
		expect(typeof load).toBe('function');
		if (!load) return;

		const originalError = console.error;
		console.error = () => undefined;
		try {
			await expect(
				load({} as Database, 'user-1', async () => {
					throw new Error('database unavailable');
				}),
			).resolves.toEqual({ status: 'error' });
		} finally {
			console.error = originalError;
		}
	});
});
