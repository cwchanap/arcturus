import type { MissionDefinition } from './types';

export const DEFAULT_DAILY_MISSIONS: MissionDefinition[] = [
	{
		id: 'daily-blackjack-5',
		title: 'Blackjack Streak',
		description: 'Play 5 Blackjack hands',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'blackjack' },
		target: 5,
		rewardChips: 500,
		icon: '\u{1F0CF}', // playing card emoji
	},
	{
		id: 'daily-win-3',
		title: 'Three Wins',
		description: 'Win 3 rounds in any game',
		period: 'daily',
		metric: { kind: 'roundsWon' },
		target: 3,
		rewardChips: 750,
		icon: '\u{1F3C6}', // trophy emoji
	},
	{
		id: 'daily-slots-20',
		title: 'Spin to Win',
		description: 'Complete 20 slot spins',
		period: 'daily',
		metric: { kind: 'spinsCompleted' },
		target: 20,
		rewardChips: 500,
		icon: '\u{2B50}', // star emoji
	},
	{
		id: 'daily-mp-1',
		title: 'Social Player',
		description: 'Finish 1 multiplayer poker hand',
		period: 'daily',
		metric: { kind: 'mpHandsCompleted' },
		target: 1,
		rewardChips: 1000,
		icon: '\u{1F3B4}', // flower playing card emoji
	},
];

export const REROLL_POOL_DAILY: MissionDefinition[] = [
	{
		id: 'daily-craps-3',
		title: 'Dice Roller',
		description: 'Play 3 Craps rounds',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'craps' },
		target: 3,
		rewardChips: 500,
		icon: '\u{1F3B2}', // game die emoji
	},
	{
		id: 'daily-baccarat-3',
		title: 'Baccarat Round',
		description: 'Play 3 Baccarat hands',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'baccarat' },
		target: 3,
		rewardChips: 500,
		icon: '\u{2666}', // diamond suit emoji
	},
	{
		id: 'daily-keno-5',
		title: 'Lucky Numbers',
		description: 'Play 5 Keno draws',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'keno' },
		target: 5,
		rewardChips: 600,
		icon: '\u{1F4DD}', // memo emoji (lotto ticket)
	},
];

export const DEFAULT_WEEKLY_MISSIONS: MissionDefinition[] = [
	{
		id: 'weekly-games-3',
		title: 'Variety Seeker',
		description: 'Play 3 different game modes this week',
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
