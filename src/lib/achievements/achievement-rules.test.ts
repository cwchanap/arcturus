import { describe, expect, test } from 'bun:test';
import {
	ACHIEVEMENTS,
	ACHIEVEMENT_CHECKS,
	ACHIEVEMENT_THRESHOLDS,
	WALLET_FEAT_GAMES,
	getAchievementById,
	getAchievementsByCategory,
} from './achievement-rules';
import type { WalletFeatId } from './achievement-rules';
import { ACHIEVEMENT_IDS } from './types';
import type { AchievementCheckContext, AchievementCheckResult, AchievementId } from './types';
import { GAME_TYPES, isValidGameType } from '../game-stats/constants';
import type { GameType } from '../game-stats/types';
import { SUPPORTED_LOCALES } from '../i18n/locale';
import { getAchievementDescription, getAchievementName } from '../i18n/messages/achievements';

function createContext(overrides: Partial<AchievementCheckContext> = {}): AchievementCheckContext {
	return {
		userId: 'test-user',
		overallRank: null,
		totalWins: 0,
		totalLosses: 0,
		totalHandsPlayed: 0,
		biggestWin: 0,
		totalNetProfit: 0,
		currentChipBalance: 10000,
		gameStats: [],
		existingAchievementIds: [],
		...overrides,
	};
}

function gameStatRow(
	gameType: GameType,
	overrides: Partial<
		Pick<AchievementCheckContext['gameStats'][number], 'handsPlayed' | 'totalWins' | 'biggestWin'>
	> = {},
): AchievementCheckContext['gameStats'][number] {
	return { gameType, handsPlayed: 1, totalWins: 0, biggestWin: 0, ...overrides };
}

function runAchievementCheck(
	id: keyof typeof ACHIEVEMENT_CHECKS,
	context: AchievementCheckContext,
): AchievementCheckResult {
	const fn = ACHIEVEMENT_CHECKS[id];
	if (!fn) throw new Error(`Achievement check '${id}' is not defined`);
	return fn(context);
}

describe('ACHIEVEMENTS', () => {
	test('contains all expected achievements', () => {
		expect(ACHIEVEMENTS.length).toBe(14);

		const ids = ACHIEVEMENTS.map((a) => a.id);
		expect(ids).toContain('rising_star');
		expect(ids).toContain('high_roller');
		expect(ids).toContain('champion');
		expect(ids).toContain('consistent');
		expect(ids).toContain('comeback');
		expect(ids).toContain('royal_treatment');
		expect(ids).toContain('sng_champion');
		expect(ids).toContain('triple_threat');
		expect(ids).toContain('straight_up');
		expect(ids).toContain('big_catch');
		expect(ids).toContain('jackpot');
		expect(ids).toContain('grand_tour');
		expect(ids).toContain('specialist');
		expect(ids).toContain('big_score');
	});

	test('all achievements have required properties', () => {
		for (const achievement of ACHIEVEMENTS) {
			expect(achievement.id).toBeDefined();
			expect(achievement.category).toBeDefined();
			expect(achievement.icon).toBeDefined();
		}
	});

	test('all achievements have check functions', () => {
		for (const achievement of ACHIEVEMENTS) {
			expect(ACHIEVEMENT_CHECKS[achievement.id]).toBeDefined();
			expect(typeof ACHIEVEMENT_CHECKS[achievement.id]).toBe('function');
		}
	});
});

describe('getAchievementById', () => {
	test('returns achievement when found', () => {
		const achievement = getAchievementById('rising_star');
		expect(achievement).toBeDefined();
		expect(achievement?.id).toBe('rising_star');
	});

	test('returns undefined when not found', () => {
		const achievement = getAchievementById('nonexistent' as any);
		expect(achievement).toBeUndefined();
	});
});

describe('getAchievementsByCategory', () => {
	test('returns leaderboard achievements', () => {
		const leaderboardAchievements = getAchievementsByCategory('leaderboard');
		expect(leaderboardAchievements.length).toBeGreaterThan(0);

		for (const achievement of leaderboardAchievements) {
			expect(achievement.category).toBe('leaderboard');
		}
	});

	test('returns milestone achievements', () => {
		const milestoneAchievements = getAchievementsByCategory('milestone');
		expect(milestoneAchievements.length).toBeGreaterThan(0);

		for (const achievement of milestoneAchievements) {
			expect(achievement.category).toBe('milestone');
		}
	});

	test('returns empty array for unknown category', () => {
		const unknownAchievements = getAchievementsByCategory('unknown' as 'leaderboard');
		expect(unknownAchievements).toEqual([]);
	});
});

describe('achievement presentation catalog', () => {
	test('resolves a name and description for every achievement in every locale', () => {
		expect([...ACHIEVEMENT_IDS].sort()).toEqual([...ACHIEVEMENTS.map((a) => a.id)].sort());
		for (const locale of SUPPORTED_LOCALES) {
			for (const id of ACHIEVEMENT_IDS) {
				expect(getAchievementName(locale, id).length).toBeGreaterThan(0);
				expect(getAchievementDescription(locale, id).length).toBeGreaterThan(0);
			}
		}
	});

	test('English keeps the authored catalog names and descriptions', () => {
		expect(getAchievementName('en', 'rising_star')).toBe('Rising Star');
		expect(getAchievementName('en', 'high_roller')).toBe('High Roller');
		expect(getAchievementName('en', 'champion')).toBe('Champion');
		expect(getAchievementName('en', 'consistent')).toBe('Consistent Winner');
		expect(getAchievementName('en', 'comeback')).toBe('Comeback King');

		expect(getAchievementDescription('en', 'rising_star')).toBe('Enter the top 50 leaderboard');
		expect(getAchievementDescription('en', 'high_roller')).toBe(
			'Reach the top 10 on the leaderboard',
		);
		expect(getAchievementDescription('en', 'champion')).toBe(
			'Reach #1 position on the leaderboard',
		);
		expect(getAchievementDescription('en', 'consistent')).toBe('Win 100 hands across all games');
		expect(getAchievementDescription('en', 'comeback')).toBe(
			'Win after dropping below 1,000 chips',
		);

		expect(getAchievementName('en', 'royal_treatment')).toBe('Royal Treatment');
		expect(getAchievementName('en', 'sng_champion')).toBe('Sit & Go Champion');
		expect(getAchievementName('en', 'triple_threat')).toBe('Triple Threat');
		expect(getAchievementName('en', 'straight_up')).toBe('Straight Up');
		expect(getAchievementName('en', 'big_catch')).toBe('Big Catch');
		expect(getAchievementName('en', 'jackpot')).toBe('Jackpot');
		expect(getAchievementName('en', 'grand_tour')).toBe('Grand Tour');
		expect(getAchievementName('en', 'specialist')).toBe('Specialist');
		expect(getAchievementName('en', 'big_score')).toBe('Big Score');

		expect(getAchievementDescription('en', 'royal_treatment')).toBe(
			'Show a royal flush at a contested showdown',
		);
		expect(getAchievementDescription('en', 'sng_champion')).toBe(
			'Finish 1st in a Sit & Go tournament',
		);
		expect(getAchievementDescription('en', 'grand_tour')).toBe('Play every game at least once');
		expect(getAchievementDescription('en', 'specialist')).toBe('Win 100 hands in a single game');
		expect(getAchievementDescription('en', 'big_score')).toBe(
			'Win 10,000 chips or more in a single game',
		);
	});

	test('descriptions interpolate thresholds with locale-aware formatting', () => {
		expect(getAchievementDescription('zh-Hant', 'rising_star')).toBe('進入排行榜前 50 名');
		expect(getAchievementDescription('zh-Hans', 'high_roller')).toBe('登上排行榜前 10 名');
		expect(getAchievementDescription('ja', 'consistent')).toBe('全ゲームで合計 100 回勝利');
		expect(getAchievementDescription('ja', 'comeback')).toBe('1,000 チップを下回った後に勝利する');
	});
});

describe('Achievement check functions', () => {
	describe('rising_star', () => {
		test('grants when user reaches top threshold', () => {
			const context = createContext({ overallRank: ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK });
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('grants when user is in top 10', () => {
			const context = createContext({ overallRank: 5 });
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is above threshold', () => {
			const context = createContext({
				overallRank: ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK + 1,
			});
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 10,
				existingAchievementIds: ['rising_star'],
			});
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('high_roller', () => {
		test('grants when user reaches top threshold', () => {
			const context = createContext({ overallRank: ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK });
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is above threshold', () => {
			const context = createContext({
				overallRank: ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK + 1,
			});
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 5,
				existingAchievementIds: ['high_roller'],
			});
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('champion', () => {
		test('grants when user is #1', () => {
			const context = createContext({ overallRank: 1 });
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is not 1', () => {
			const context = createContext({ overallRank: 2 });
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 1,
				existingAchievementIds: ['champion'],
			});
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('consistent', () => {
		test('grants when user reaches win threshold', () => {
			const context = createContext({ totalWins: ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS });
			const result = runAchievementCheck('consistent', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when wins below threshold', () => {
			const context = createContext({ totalWins: ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS - 1 });
			const result = runAchievementCheck('consistent', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				totalWins: 150,
				existingAchievementIds: ['consistent'],
			});
			const result = runAchievementCheck('consistent', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('comeback', () => {
		test('grants when recovering from low balance with a win', () => {
			// User was below threshold, won and recovered
			const balanceBelowThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE - 500; // threshold minus 500 chips
			const winAmount = 1500;
			const newBalance = balanceBelowThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('grants when barely below threshold', () => {
			// User was at threshold - 1, won something
			const balanceBelowThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE - 1;
			const winAmount = 100;
			const newBalance = balanceBelowThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when was not below threshold before win', () => {
			// User was above threshold before win
			const balanceAboveThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE + 3000;
			const winAmount = 1000;
			const newBalance = balanceAboveThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant without a win', () => {
			const context = createContext({
				currentChipBalance: 500,
				recentWinAmount: 0,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no recent win info', () => {
			const context = createContext({
				currentChipBalance: 2000,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when current balance is missing', () => {
			const context = createContext({
				currentChipBalance: null as unknown as number,
				recentWinAmount: 200,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				currentChipBalance: 2000,
				recentWinAmount: 1500,
				existingAchievementIds: ['comeback'],
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('WALLET_FEAT_GAMES', () => {
		test('contains exactly the five wallet feats with their eligible games', () => {
			expect(Object.keys(WALLET_FEAT_GAMES).sort()).toEqual([
				'big_catch',
				'jackpot',
				'royal_treatment',
				'straight_up',
				'triple_threat',
			]);
			expect(WALLET_FEAT_GAMES.royal_treatment).toEqual(['poker', 'video-poker']);
			expect(WALLET_FEAT_GAMES.triple_threat).toEqual(['sic-bo']);
			expect(WALLET_FEAT_GAMES.straight_up).toEqual(['roulette']);
			expect(WALLET_FEAT_GAMES.big_catch).toEqual(['keno']);
			expect(WALLET_FEAT_GAMES.jackpot).toEqual(['slots']);
		});

		test('keeps feat IDs and game values within their closed unions', () => {
			// Compile-time assertion: WalletFeatId must stay exactly the table keys.
			const walletFeatIds: readonly WalletFeatId[] = [
				'royal_treatment',
				'triple_threat',
				'straight_up',
				'big_catch',
				'jackpot',
			];
			expect([...walletFeatIds].sort()).toEqual(
				Object.keys(WALLET_FEAT_GAMES).sort() as WalletFeatId[],
			);

			for (const games of Object.values(WALLET_FEAT_GAMES)) {
				for (const game of games) {
					expect(isValidGameType(game)).toBe(true);
				}
			}
		});

		test('rejects misspelled feat IDs at compile time', () => {
			const misspelled = {
				// @ts-expect-error - a misspelled key fails the satisfies constraint
				royal_treatmen: ['poker'],
			} as const satisfies Partial<Record<AchievementId, readonly GameType[]>>;
			expect(Object.keys(misspelled)).toEqual(['royal_treatmen']);
		});
	});

	describe('reported feat checks', () => {
		const FEAT_CHECK_IDS: AchievementId[] = [
			'royal_treatment',
			'sng_champion',
			'triple_threat',
			'straight_up',
			'big_catch',
			'jackpot',
		];

		test.each(FEAT_CHECK_IDS)('%s: grants when the feat is reported', (id) => {
			const context = createContext({ feats: [id], gameType: 'keno' });
			const result = runAchievementCheck(id, context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('keno');
		});

		test.each(FEAT_CHECK_IDS)('%s: does not grant without the feat', (id) => {
			const context = createContext({ feats: [], gameType: 'keno' });
			expect(runAchievementCheck(id, context).shouldGrant).toBe(false);
		});

		test.each(FEAT_CHECK_IDS)('%s: does not grant when already earned', (id) => {
			const context = createContext({
				feats: [id],
				gameType: 'keno',
				existingAchievementIds: [id],
			});
			expect(runAchievementCheck(id, context).shouldGrant).toBe(false);
		});
	});

	describe('grand_tour', () => {
		const allGames = GAME_TYPES.map((game) => gameStatRow(game));

		test('grants when every game has at least one hand played', () => {
			const context = createContext({ gameStats: [...allGames].reverse() });
			const result = runAchievementCheck('grand_tour', context);
			expect(result.shouldGrant).toBe(true);
			// Global achievement - stored without a game type
			expect(result.gameType).toBeUndefined();
		});

		test('does not grant when one game has no stats row', () => {
			const context = createContext({ gameStats: allGames.slice(1) });
			expect(runAchievementCheck('grand_tour', context).shouldGrant).toBe(false);
		});

		test('does not grant when one game has zero hands', () => {
			const rows = allGames.map((row, index) =>
				index === 4 ? gameStatRow(row.gameType, { handsPlayed: 0 }) : row,
			);
			const context = createContext({ gameStats: rows });
			expect(runAchievementCheck('grand_tour', context).shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				gameStats: allGames,
				existingAchievementIds: ['grand_tour'],
			});
			expect(runAchievementCheck('grand_tour', context).shouldGrant).toBe(false);
		});
	});

	describe('specialist', () => {
		test('grants at 100 wins in one game', () => {
			const context = createContext({
				gameStats: [gameStatRow('keno', { totalWins: ACHIEVEMENT_THRESHOLDS.SPECIALIST_WINS })],
			});
			const result = runAchievementCheck('specialist', context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('keno');
		});

		test('does not grant at 99 wins', () => {
			const context = createContext({
				gameStats: [gameStatRow('keno', { totalWins: ACHIEVEMENT_THRESHOLDS.SPECIALIST_WINS - 1 })],
			});
			expect(runAchievementCheck('specialist', context).shouldGrant).toBe(false);
		});

		test('does not grant from aggregate wins without a qualifying single game', () => {
			const context = createContext({ totalWins: 100 });
			expect(runAchievementCheck('specialist', context).shouldGrant).toBe(false);
		});

		test('attributes the current settling game when it qualifies', () => {
			const context = createContext({
				gameType: 'keno',
				gameStats: [
					gameStatRow('poker', { totalWins: 100 }),
					gameStatRow('keno', { totalWins: 100 }),
				],
			});
			const result = runAchievementCheck('specialist', context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('keno');
		});

		test('attributes the first qualifying GAME_TYPES entry otherwise', () => {
			const context = createContext({
				gameType: 'roulette',
				gameStats: [
					gameStatRow('keno', { totalWins: 100 }),
					gameStatRow('baccarat', { totalWins: 100 }),
				],
			});
			const result = runAchievementCheck('specialist', context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('baccarat');
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				gameStats: [gameStatRow('keno', { totalWins: 100 })],
				existingAchievementIds: ['specialist'],
			});
			expect(runAchievementCheck('specialist', context).shouldGrant).toBe(false);
		});
	});

	describe('big_score', () => {
		test('grants at a 10,000 single-game biggest win', () => {
			const context = createContext({
				gameStats: [gameStatRow('slots', { biggestWin: ACHIEVEMENT_THRESHOLDS.BIG_SCORE_WIN })],
			});
			const result = runAchievementCheck('big_score', context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('slots');
		});

		test('does not grant below the threshold', () => {
			const context = createContext({
				gameStats: [gameStatRow('slots', { biggestWin: ACHIEVEMENT_THRESHOLDS.BIG_SCORE_WIN - 1 })],
			});
			expect(runAchievementCheck('big_score', context).shouldGrant).toBe(false);
		});

		test('attributes the current settling game when it qualifies', () => {
			const context = createContext({
				gameType: 'slots',
				gameStats: [
					gameStatRow('poker', { biggestWin: 10000 }),
					gameStatRow('slots', { biggestWin: 10000 }),
				],
			});
			const result = runAchievementCheck('big_score', context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('slots');
		});

		test('attributes the first qualifying GAME_TYPES entry otherwise', () => {
			const context = createContext({
				gameStats: [
					gameStatRow('keno', { biggestWin: 10000 }),
					gameStatRow('craps', { biggestWin: 10000 }),
				],
			});
			const result = runAchievementCheck('big_score', context);
			expect(result.shouldGrant).toBe(true);
			expect(result.gameType).toBe('craps');
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				gameStats: [gameStatRow('slots', { biggestWin: 10000 })],
				existingAchievementIds: ['big_score'],
			});
			expect(runAchievementCheck('big_score', context).shouldGrant).toBe(false);
		});
	});
});
