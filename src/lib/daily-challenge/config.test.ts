import { describe, expect, test } from 'bun:test';
import { BLACKJACK_DAILY_V1_CONFIG, getDailyChallengeWindow } from './config';

describe('BLACKJACK_DAILY_V1_CONFIG', () => {
	test('pins the immutable v1 challenge constants', () => {
		expect(BLACKJACK_DAILY_V1_CONFIG).toEqual({
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameType: 'blackjack',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startingBankroll: 1000,
			roundCount: 10,
			minimumWager: 10,
			maximumWager: 1000,
			attemptTtlSeconds: 1800,
			rankedEntryCloseOffsetSeconds: 1800,
		});
	});

	test('is frozen immutable', () => {
		expect(Object.isFrozen(BLACKJACK_DAILY_V1_CONFIG)).toBe(true);
	});
});

describe('getDailyChallengeWindow', () => {
	test('aligns a midday timestamp to the UTC midnight window', () => {
		const window = getDailyChallengeWindow(Date.UTC(2026, 2, 14, 12, 30, 0) / 1000);
		expect(window).toEqual({
			periodKey: '2026-03-14',
			startsAt: Date.UTC(2026, 2, 14) / 1000,
			rankedEntryClosesAt: Date.UTC(2026, 2, 14) / 1000 + 24 * 60 * 60 - 1800,
			endsAt: Date.UTC(2026, 2, 14) / 1000 + 24 * 60 * 60,
		});
	});

	test('handles leap day', () => {
		const window = getDailyChallengeWindow(Date.UTC(2024, 1, 29, 23, 59, 59) / 1000);
		expect(window.periodKey).toBe('2024-02-29');
		expect(window.endsAt).toBe(Date.UTC(2024, 2, 1) / 1000);
	});

	test('handles month end', () => {
		const window = getDailyChallengeWindow(Date.UTC(2026, 3, 30, 0, 0, 0) / 1000);
		expect(window.periodKey).toBe('2026-04-30');
		expect(window.endsAt).toBe(Date.UTC(2026, 4, 1) / 1000);
	});

	test('handles year end into a new year', () => {
		const window = getDailyChallengeWindow(Date.UTC(2026, 11, 31, 23, 30, 0) / 1000);
		expect(window.periodKey).toBe('2026-12-31');
		expect(window.endsAt).toBe(Date.UTC(2027, 0, 1) / 1000);
	});

	test('ranks entry closes 1800s before the window ends', () => {
		const window = getDailyChallengeWindow(Date.UTC(2026, 0, 1, 23, 30, 0) / 1000);
		expect(window.endsAt - window.rankedEntryClosesAt).toBe(1800);
	});

	test('exactly midnight resolves to the same UTC day window', () => {
		const midnight = Date.UTC(2026, 5, 15, 0, 0, 0) / 1000;
		const window = getDailyChallengeWindow(midnight);
		expect(window.startsAt).toBe(midnight);
		expect(window.endsAt).toBe(midnight + 24 * 60 * 60);
	});

	test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid now value %p',
		(nowSeconds) => {
			expect(() => getDailyChallengeWindow(nowSeconds)).toThrow();
		},
	);
});
