/**
 * Closed mission definition ID set: every mission the product ships. Adding a
 * mission means adding its ID here first — the registry definitions, the
 * mission message dictionaries, and the missions page all key off this union.
 */
export const MISSION_IDS = [
	'daily-blackjack-5',
	'daily-win-3',
	'daily-slots-20',
	'daily-craps-3',
	'daily-baccarat-3',
	'daily-keno-5',
	'weekly-games-3',
] as const;

export type MissionId = (typeof MISSION_IDS)[number];

export type MissionMetric =
	| { kind: 'handsPlayed'; gameType?: string }
	| { kind: 'roundsWon'; gameType?: string }
	| { kind: 'spinsCompleted' }
	| { kind: 'gamesTried' };

export interface MissionDefinition {
	id: MissionId;
	period: 'daily' | 'weekly';
	metric: MissionMetric;
	target: number;
	rewardChips: number;
	icon: string;
}

export interface MissionGameEvent {
	gameType: string;
	outcome: 'win' | 'loss' | 'push' | null | undefined;
	handCount: number;
	winsIncrement: number;
	lossesIncrement: number;
	delta: number;
}

export interface MissionView {
	missionDefId: MissionId;
	icon: string;
	period: 'daily' | 'weekly';
	progress: number;
	target: number;
	completed: boolean;
	claimed: boolean;
	claimable: boolean;
	rewardChips: number;
	isOverride: boolean;
}

export interface StreakView {
	current: number;
	longest: number;
	claimableToday: boolean;
	dayOfCycle: number;
	rewardPreview: number;
	lastClaimPeriodKey: string;
}

export interface BoardState {
	streak: StreakView;
	daily: MissionView[];
	weekly: MissionView[];
	rerollAvailable: boolean;
	nextDailyReset: string;
	nextWeeklyReset: string;
	chipBalance: number;
}
