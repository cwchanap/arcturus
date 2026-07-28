import { getDailyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';

export const STREAK_REWARDS = [1000, 1250, 1500, 2000, 2500, 3500, 5000] as const;

export function getStreakReward(currentStreak: number): number {
	return STREAK_REWARDS[getDayOfCycle(currentStreak) - 1];
}

export function getDayOfCycle(currentStreak: number): number {
	const streak = currentStreak > 0 ? currentStreak : 1;
	return ((streak - 1) % STREAK_REWARDS.length) + 1;
}

export interface EffectiveStreakInput {
	currentStreak: number;
	longestStreak: number;
	lastClaimPeriodKey: string;
	today: string;
	yesterday: string;
}

export interface EffectiveStreakResult {
	displayStreak: number;
	longestStreak: number;
	claimableToday: boolean;
	dayOfCycle: number;
	rewardPreview: number;
}

export function computeEffectiveStreak(input: EffectiveStreakInput): EffectiveStreakResult {
	const { currentStreak, longestStreak, lastClaimPeriodKey, today, yesterday } = input;

	if (lastClaimPeriodKey === today) {
		return {
			displayStreak: currentStreak,
			longestStreak,
			claimableToday: false,
			dayOfCycle: getDayOfCycle(currentStreak),
			rewardPreview: 0,
		};
	}

	if (lastClaimPeriodKey === yesterday) {
		const nextStreak = currentStreak + 1;
		return {
			displayStreak: currentStreak,
			longestStreak,
			claimableToday: true,
			dayOfCycle: getDayOfCycle(nextStreak),
			rewardPreview: getStreakReward(nextStreak),
		};
	}

	return {
		displayStreak: 0,
		longestStreak,
		claimableToday: true,
		dayOfCycle: 1,
		rewardPreview: STREAK_REWARDS[0],
	};
}

export interface StreakTransitionInput {
	currentStreak: number;
	longestStreak: number;
	lastClaimPeriodKey: string;
	today: string;
	yesterday: string;
}

export interface StreakTransitionResult {
	newStreak: number;
	newLongest: number;
	dayOfCycle: number;
	reward: number;
}

export function computeStreakTransition(input: StreakTransitionInput): StreakTransitionResult {
	const { currentStreak, longestStreak, lastClaimPeriodKey, yesterday } = input;

	const newStreak = lastClaimPeriodKey === yesterday ? currentStreak + 1 : 1;
	const newLongest = Math.max(longestStreak, newStreak);
	const dayOfCycle = getDayOfCycle(newStreak);
	const reward = getStreakReward(newStreak);

	return { newStreak, newLongest, dayOfCycle, reward };
}

export function computeEffectiveStreakFromStored(
	stored: { currentStreak: number; longestStreak: number; lastClaimPeriodKey: string } | null,
): EffectiveStreakResult {
	const today = getDailyPeriodKey();
	const yesterday = getDailyPeriodKeyForYesterday();

	if (!stored) {
		return computeEffectiveStreak({
			currentStreak: 0,
			longestStreak: 0,
			lastClaimPeriodKey: '',
			today,
			yesterday,
		});
	}

	return computeEffectiveStreak({ ...stored, today, yesterday });
}
