export type MissionMetric =
	| { kind: 'handsPlayed'; gameType?: string }
	| { kind: 'roundsWon'; gameType?: string }
	| { kind: 'spinsCompleted' }
	| { kind: 'gamesTried' };

export interface MissionDefinition {
	id: string;
	title: string;
	description: string;
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
	missionDefId: string;
	title: string;
	description: string;
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
