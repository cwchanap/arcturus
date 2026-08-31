import type { MissionDefinition } from './types';

export const DEFAULT_DAILY_MISSIONS: MissionDefinition[] = [
	{
		id: 'daily-blackjack-5',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'blackjack' },
		target: 5,
		rewardChips: 500,
		icon: '\u{1F0CF}', // playing card emoji
	},
	{
		id: 'daily-win-3',
		period: 'daily',
		metric: { kind: 'roundsWon' },
		target: 3,
		rewardChips: 750,
		icon: '\u{1F3C6}', // trophy emoji
	},
	{
		id: 'daily-slots-20',
		period: 'daily',
		metric: { kind: 'spinsCompleted' },
		target: 20,
		rewardChips: 500,
		icon: '\u{1F3B0}', // slot machine emoji — matches GAME_TYPE_ICONS.slots
	},
];

export const REROLL_POOL_DAILY: MissionDefinition[] = [
	{
		id: 'daily-craps-3',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'craps' },
		target: 3,
		rewardChips: 500,
		icon: '\u{1F3B2}', // game die emoji
	},
	{
		id: 'daily-baccarat-3',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'baccarat' },
		target: 3,
		rewardChips: 500,
		icon: '\u{1F3B4}', // flower playing card emoji — matches GAME_TYPE_ICONS.baccarat
	},
	{
		id: 'daily-keno-5',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'keno' },
		target: 5,
		rewardChips: 600,
		icon: '\u{1F3B1}', // billiards emoji — matches GAME_TYPE_ICONS.keno
	},
];

export const DEFAULT_WEEKLY_MISSIONS: MissionDefinition[] = [
	{
		id: 'weekly-games-3',
		period: 'weekly',
		metric: { kind: 'gamesTried' },
		target: 3,
		rewardChips: 2000,
		icon: '\u{1F4C5}', // calendar emoji
	},
];

export const ALL_DAILY_DEFINITIONS: MissionDefinition[] = [
	...DEFAULT_DAILY_MISSIONS,
	...REROLL_POOL_DAILY,
];

const ALL_DEFINITIONS = [...ALL_DAILY_DEFINITIONS, ...DEFAULT_WEEKLY_MISSIONS];

export function getMissionDef(id: string): MissionDefinition | undefined {
	return ALL_DEFINITIONS.find((m) => m.id === id);
}

export function getAllMissionDefIds(): string[] {
	return ALL_DEFINITIONS.map((m) => m.id);
}
