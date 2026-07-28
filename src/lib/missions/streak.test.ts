import { describe, expect, test } from 'bun:test';
import {
	STREAK_REWARDS,
	getStreakReward,
	getDayOfCycle,
	computeEffectiveStreak,
	computeStreakTransition,
	computeEffectiveStreakFromStored,
} from './streak';
import { getDailyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';

describe('streak rewards', () => {
	test('day 1 reward is 1000 (matches old daily login)', () => {
		expect(getStreakReward(1)).toBe(1000);
	});

	test('day 7 reward is 5000', () => {
		expect(getStreakReward(7)).toBe(5000);
	});

	test('reward escalates monotonically within cycle', () => {
		for (let day = 2; day <= 7; day++) {
			expect(getStreakReward(day)).toBeGreaterThan(getStreakReward(day - 1));
		}
	});

	test('day 8 cycles back to day-1 reward (1000)', () => {
		expect(getStreakReward(8)).toBe(1000);
	});

	test('day 14 cycles back to day-7 reward (5000)', () => {
		expect(getStreakReward(14)).toBe(5000);
	});

	test('day 15 cycles back to day-1 reward', () => {
		expect(getStreakReward(15)).toBe(1000);
	});
});

describe('computeEffectiveStreak (display)', () => {
	const today = '2026-07-26';
	const yesterday = '2026-07-25';
	const threeDaysAgo = '2026-07-23';

	test('already claimed today → not claimable, reward 0', () => {
		const result = computeEffectiveStreak({
			currentStreak: 5,
			longestStreak: 10,
			lastClaimPeriodKey: today,
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(5);
		expect(result.claimableToday).toBe(false);
		expect(result.rewardPreview).toBe(0);
	});

	test('last claim yesterday → continuing, reward = next day', () => {
		const result = computeEffectiveStreak({
			currentStreak: 2,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(2);
		expect(result.claimableToday).toBe(true);
		expect(result.rewardPreview).toBe(getStreakReward(3));
	});

	test('gap of 3 day → broken, display 0, reward = day 1', () => {
		const result = computeEffectiveStreak({
			currentStreak: 5,
			longestStreak: 10,
			lastClaimPeriodKey: threeDaysAgo,
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(0);
		expect(result.claimableToday).toBe(true);
		expect(result.rewardPreview).toBe(1000);
	});

	test('never claimed → broken, display 0, reward = day 1', () => {
		const result = computeEffectiveStreak({
			currentStreak: 0,
			longestStreak: 0,
			lastClaimPeriodKey: '',
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(0);
		expect(result.claimableToday).toBe(true);
		expect(result.rewardPreview).toBe(1000);
	});
});

describe('computeStreakTransition (on claim)', () => {
	const today = '2026-07-26';
	const yesterday = '2026-07-25';

	test('continuing from yesterday', () => {
		const result = computeStreakTransition({
			currentStreak: 3,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(4);
		expect(result.newLongest).toBe(5);
		expect(result.dayOfCycle).toBe(4);
		expect(result.reward).toBe(getStreakReward(4));
	});

	test('broken streak resets to 1', () => {
		const result = computeStreakTransition({
			currentStreak: 5,
			longestStreak: 5,
			lastClaimPeriodKey: '2026-07-20',
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(1);
		expect(result.newLongest).toBe(5);
		expect(result.dayOfCycle).toBe(1);
		expect(result.reward).toBe(1000);
	});

	test('first ever claim', () => {
		const result = computeStreakTransition({
			currentStreak: 0,
			longestStreak: 0,
			lastClaimPeriodKey: '',
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(1);
		expect(result.newLongest).toBe(1);
		expect(result.reward).toBe(1000);
	});

	test('longest streak updates when current exceeds it', () => {
		const result = computeStreakTransition({
			currentStreak: 5,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(6);
		expect(result.newLongest).toBe(6);
	});
});

describe('getDayOfCycle', () => {
	test('day 1 → 1, day 7 → 7, day 8 cycles back to 1', () => {
		expect(getDayOfCycle(1)).toBe(1);
		expect(getDayOfCycle(7)).toBe(7);
		expect(getDayOfCycle(8)).toBe(1);
		expect(getDayOfCycle(14)).toBe(7);
		expect(getDayOfCycle(15)).toBe(1);
	});

	test('matches the cycle used by getStreakReward', () => {
		for (let streak = 1; streak <= 21; streak++) {
			const day = getDayOfCycle(streak);
			expect(getStreakReward(streak)).toBe(STREAK_REWARDS[day - 1]);
		}
	});
});

describe('computeEffectiveStreakFromStored', () => {
	const today = getDailyPeriodKey();
	const yesterday = getDailyPeriodKeyForYesterday();

	test('null stored → broken streak, claimable, day-1 reward', () => {
		const result = computeEffectiveStreakFromStored(null);
		expect(result.displayStreak).toBe(0);
		expect(result.claimableToday).toBe(true);
		expect(result.dayOfCycle).toBe(1);
		expect(result.rewardPreview).toBe(STREAK_REWARDS[0]);
	});

	test('stored lastClaimPeriodKey === today → not claimable, reward 0', () => {
		const result = computeEffectiveStreakFromStored({
			currentStreak: 4,
			longestStreak: 6,
			lastClaimPeriodKey: today,
		});
		expect(result.displayStreak).toBe(4);
		expect(result.claimableToday).toBe(false);
		expect(result.rewardPreview).toBe(0);
		expect(result.dayOfCycle).toBe(getDayOfCycle(4));
	});

	test('stored lastClaimPeriodKey === yesterday → continuing, claimable', () => {
		const result = computeEffectiveStreakFromStored({
			currentStreak: 2,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
		});
		expect(result.displayStreak).toBe(2);
		expect(result.claimableToday).toBe(true);
		expect(result.dayOfCycle).toBe(getDayOfCycle(3));
		expect(result.rewardPreview).toBe(getStreakReward(3));
	});

	test('stored lastClaimPeriodKey older than yesterday → broken, day-1 reward', () => {
		const result = computeEffectiveStreakFromStored({
			currentStreak: 5,
			longestStreak: 10,
			lastClaimPeriodKey: '2020-01-01',
		});
		expect(result.displayStreak).toBe(0);
		expect(result.claimableToday).toBe(true);
		expect(result.dayOfCycle).toBe(1);
		expect(result.rewardPreview).toBe(STREAK_REWARDS[0]);
	});

	test('preserves longestStreak from stored row regardless of claim state', () => {
		const longestStreak = 42;
		const claimed = computeEffectiveStreakFromStored({
			currentStreak: 4,
			longestStreak,
			lastClaimPeriodKey: today,
		});
		expect(claimed.longestStreak).toBe(longestStreak);
		const broken = computeEffectiveStreakFromStored({
			currentStreak: 4,
			longestStreak,
			lastClaimPeriodKey: '2020-01-01',
		});
		expect(broken.longestStreak).toBe(longestStreak);
	});
});
