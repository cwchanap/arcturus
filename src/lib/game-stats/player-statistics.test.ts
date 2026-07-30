import { describe, expect, test } from 'bun:test';
import { GAME_TYPES } from './constants';
import {
	PlayerStatisticsIntegrityError,
	buildPlayerStatisticsDashboard,
} from './player-statistics';
import type { PlayerStatisticsSourceRow } from './player-statistics-types';

const updatedAt = new Date('2026-07-30T00:00:00Z');

function row(overrides: Partial<PlayerStatisticsSourceRow>): PlayerStatisticsSourceRow {
	return {
		userId: 'user-1',
		gameType: 'blackjack',
		totalWins: 0,
		totalLosses: 0,
		handsPlayed: 0,
		biggestWin: 0,
		netProfit: 0,
		updatedAt,
		...overrides,
	};
}

describe('buildPlayerStatisticsDashboard', () => {
	test('zero-fills every canonical game in canonical order', () => {
		const dashboard = buildPlayerStatisticsDashboard([], new Map());

		expect(dashboard.games.map((game) => game.gameType)).toEqual([...GAME_TYPES]);
		expect(dashboard.games.every((game) => game.handsPlayed === 0)).toBe(true);
		expect(dashboard.summary).toEqual({
			totalHands: 0,
			totalWins: 0,
			totalLosses: 0,
			overallWinRate: 0,
			totalNetProfit: 0,
			mostPlayedGame: null,
		});
	});

	test('uses weighted overall win rate and canonical tie-break', () => {
		const dashboard = buildPlayerStatisticsDashboard([
			row({
				gameType: 'baccarat',
				totalWins: 1,
				totalLosses: 9,
				handsPlayed: 10,
				biggestWin: 25,
				netProfit: -10,
			}),
			row({
				gameType: 'blackjack',
				totalWins: 9,
				totalLosses: 1,
				handsPlayed: 10,
				biggestWin: 100,
				netProfit: 40,
			}),
		]);

		expect(dashboard.summary.overallWinRate).toBe(50);
		expect(dashboard.summary.mostPlayedGame).toBe('blackjack');
	});

	test('keeps pushes in hand totals while excluding them from win rates', () => {
		const dashboard = buildPlayerStatisticsDashboard([
			row({ gameType: 'craps', totalWins: 1, totalLosses: 1, handsPlayed: 5 }),
		]);

		expect(dashboard.summary.totalHands).toBe(5);
		expect(dashboard.summary.overallWinRate).toBe(50);
		expect(dashboard.games.find((game) => game.gameType === 'craps')).toMatchObject({
			handsPlayed: 5,
			winRate: 50,
		});
	});

	test('ignores unknown rows and retains the canonical dashboard shape', () => {
		const dashboard = buildPlayerStatisticsDashboard([
			row({ gameType: 'unsupported-game', totalWins: 99, handsPlayed: 99 }),
		]);

		expect(dashboard.games.map((game) => game.gameType)).toEqual([...GAME_TYPES]);
		expect(dashboard.summary.totalHands).toBe(0);
	});

	test('throws on duplicate canonical rows', () => {
		const blackjack = row({
			gameType: 'blackjack',
			totalWins: 1,
			handsPlayed: 1,
			biggestWin: 10,
			netProfit: 10,
		});

		expect(() => buildPlayerStatisticsDashboard([blackjack, blackjack])).toThrow(
			PlayerStatisticsIntegrityError,
		);
	});

	test('uses null for missing ranks and any zero-hand game rank', () => {
		const dashboard = buildPlayerStatisticsDashboard(
			[
				row({ gameType: 'blackjack', totalWins: 1, handsPlayed: 1 }),
				row({ gameType: 'baccarat', totalWins: 1, handsPlayed: 0 }),
			],
			new Map([['baccarat', 3]]),
		);

		expect(dashboard.games.find((game) => game.gameType === 'blackjack')?.winsRank).toBeNull();
		expect(dashboard.games.find((game) => game.gameType === 'baccarat')?.winsRank).toBeNull();
	});

	test('keeps numeric wins ranks for active games with zero wins', () => {
		const dashboard = buildPlayerStatisticsDashboard(
			[row({ gameType: 'roulette', totalLosses: 2, handsPlayed: 2 })],
			new Map([['roulette', 8]]),
		);

		expect(dashboard.games.find((game) => game.gameType === 'roulette')).toMatchObject({
			totalWins: 0,
			handsPlayed: 2,
			winsRank: 8,
		});
	});
});
