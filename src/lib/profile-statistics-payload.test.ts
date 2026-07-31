import { describe, expect, test } from 'bun:test';
import { GAME_TYPES } from './game-stats/constants';
import type { PlayerStatisticsDashboard } from './game-stats/player-statistics-types';
import { parsePlayerStatisticsDashboard } from './profile-statistics-payload';

function createDashboard(): PlayerStatisticsDashboard {
	return {
		summary: {
			totalHands: 4,
			totalWins: 3,
			totalLosses: 1,
			overallWinRate: 75,
			totalNetProfit: 50,
			mostPlayedGame: 'blackjack',
		},
		games: GAME_TYPES.map((gameType, index) => ({
			gameType,
			totalWins: index === 0 ? 3 : 0,
			totalLosses: index === 0 ? 1 : 0,
			handsPlayed: index === 0 ? 4 : 0,
			winRate: index === 0 ? 75 : 0,
			netProfit: index === 0 ? 50 : 0,
			biggestWin: index === 0 ? 50 : 0,
			winsRank: index === 0 ? 1 : null,
		})),
	};
}

function cloneDashboard(): PlayerStatisticsDashboard {
	return structuredClone(createDashboard());
}

describe('parsePlayerStatisticsDashboard', () => {
	test('accepts the canonical payload without recomputing its aggregate values', () => {
		const dashboard = cloneDashboard();
		dashboard.summary = {
			...dashboard.summary,
			totalHands: 999,
			totalWins: 998,
			totalLosses: 997,
			overallWinRate: 12.5,
			totalNetProfit: -123,
			mostPlayedGame: 'keno',
		};

		expect(parsePlayerStatisticsDashboard(dashboard)).toEqual(dashboard);
	});

	test('rejects reordered, missing, duplicate, and unknown games', () => {
		const reordered = cloneDashboard();
		[reordered.games[0], reordered.games[1]] = [reordered.games[1], reordered.games[0]];

		const missing = cloneDashboard();
		missing.games.pop();

		const duplicate = cloneDashboard();
		duplicate.games[1] = { ...duplicate.games[1], gameType: 'blackjack' };

		const unknown = cloneDashboard();
		unknown.games[0] = { ...unknown.games[0], gameType: 'war' as never };

		for (const invalid of [reordered, missing, duplicate, unknown]) {
			expect(() => parsePlayerStatisticsDashboard(invalid)).toThrow();
		}
	});

	test('rejects negative, fractional, and unsafe integer counts', () => {
		const negative = cloneDashboard();
		negative.games[0].handsPlayed = -1;

		const fractional = cloneDashboard();
		fractional.summary.totalWins = 1.5;

		const unsafe = cloneDashboard();
		unsafe.games[0].totalLosses = Number.MAX_SAFE_INTEGER + 1;

		for (const invalid of [negative, fractional, unsafe]) {
			expect(() => parsePlayerStatisticsDashboard(invalid)).toThrow();
		}
	});

	test('rejects percentages outside the inclusive 0-to-100 range', () => {
		const belowRange = cloneDashboard();
		belowRange.games[0].winRate = -0.01;

		const aboveRange = cloneDashboard();
		aboveRange.summary.overallWinRate = 100.01;

		for (const invalid of [belowRange, aboveRange]) {
			expect(() => parsePlayerStatisticsDashboard(invalid)).toThrow();
		}
	});

	test('rejects non-positive ranks and ranks assigned to zero-hand games', () => {
		const nonPositiveRank = cloneDashboard();
		nonPositiveRank.games[0].winsRank = 0;

		const zeroHandRank = cloneDashboard();
		zeroHandRank.games[1].winsRank = 2;

		for (const invalid of [nonPositiveRank, zeroHandRank]) {
			expect(() => parsePlayerStatisticsDashboard(invalid)).toThrow();
		}
	});
});
