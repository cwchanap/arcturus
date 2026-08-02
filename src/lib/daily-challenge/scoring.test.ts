import { describe, expect, test } from 'bun:test';
import {
	calculateDailyChallengePercentile,
	compareDailyChallengeScores,
	type DailyChallengeScore,
} from './scoring';

describe('compareDailyChallengeScores', () => {
	test('ranks the higher ending bankroll first', () => {
		const left: DailyChallengeScore = { endingBankroll: 1100, roundsCompleted: 5 };
		const right: DailyChallengeScore = { endingBankroll: 900, roundsCompleted: 10 };

		expect(compareDailyChallengeScores(left, right)).toBeLessThan(0);
	});

	test('breaks a bankroll tie by more rounds completed', () => {
		const left: DailyChallengeScore = { endingBankroll: 1000, roundsCompleted: 5 };
		const right: DailyChallengeScore = { endingBankroll: 1000, roundsCompleted: 9 };

		expect(compareDailyChallengeScores(left, right)).toBeGreaterThan(0);
	});

	test('returns zero for identical scores', () => {
		const score: DailyChallengeScore = { endingBankroll: 1000, roundsCompleted: 10 };

		expect(compareDailyChallengeScores(score, { ...score })).toBe(0);
	});
});

describe('calculateDailyChallengePercentile', () => {
	test('assigns 100 to the top of the population', () => {
		expect(calculateDailyChallengePercentile(100, 0)).toBe(100);
	});

	test('assigns 1 to the bottom of the population', () => {
		expect(calculateDailyChallengePercentile(100, 99)).toBe(1);
	});

	test('rounds an intermediate ratio to the nearest whole percentile', () => {
		expect(calculateDailyChallengePercentile(3, 1)).toBe(67);
	});

	test('assigns 100 to the sole eligible player', () => {
		expect(calculateDailyChallengePercentile(1, 0)).toBe(100);
	});

	test.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid totalEligible (%p)',
		(totalEligible) => {
			expect(() => calculateDailyChallengePercentile(totalEligible, 0)).toThrow(RangeError);
		},
	);

	test.each([-1, 0.5])(
		'rejects a negative or fractional playersStrictlyAbove (%p)',
		(playersStrictlyAbove) => {
			expect(() => calculateDailyChallengePercentile(10, playersStrictlyAbove)).toThrow(RangeError);
		},
	);

	test.each([10, 11])(
		'rejects playersStrictlyAbove at or above totalEligible (%p)',
		(playersStrictlyAbove) => {
			expect(() => calculateDailyChallengePercentile(10, playersStrictlyAbove)).toThrow(RangeError);
		},
	);
});
