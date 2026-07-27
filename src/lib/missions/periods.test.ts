import { describe, expect, test } from 'bun:test';
import {
	getDailyPeriodKey,
	getWeeklyPeriodKey,
	getDailyPeriodKeyForYesterday,
	getNextDailyReset,
	getNextWeeklyReset,
} from './periods';

describe('period keys', () => {
	test('daily key is YYYY-MM-DD in UTC', () => {
		const date = new Date('2026-07-26T15:30:00Z');
		expect(getDailyPeriodKey(date)).toBe('2026-07-26');
	});

	test('daily key at UTC midnight boundary', () => {
		expect(getDailyPeriodKey(new Date('2026-07-26T00:00:00Z'))).toBe('2026-07-26');
		expect(getDailyPeriodKey(new Date('2026-07-25T23:59:59Z'))).toBe('2026-07-25');
	});

	test('daily key is timezone-independent (local time does not affect result)', () => {
		const utc = new Date('2026-07-26T22:00:00Z');
		expect(getDailyPeriodKey(utc)).toBe('2026-07-26');
	});

	test('yesterday key', () => {
		const date = new Date('2026-07-26T12:00:00Z');
		expect(getDailyPeriodKeyForYesterday(date)).toBe('2026-07-25');
	});

	test('weekly key is ISO week number (Monday-based)', () => {
		// 2026-07-26 is a Sunday → ISO week 30
		expect(getWeeklyPeriodKey(new Date('2026-07-26T12:00:00Z'))).toBe('2026-W30');
		// 2026-07-20 is a Monday → start of week 30
		expect(getWeeklyPeriodKey(new Date('2026-07-20T12:00:00Z'))).toBe('2026-W30');
		// 2026-07-19 is a Sunday → end of week 29
		expect(getWeeklyPeriodKey(new Date('2026-07-19T12:00:00Z'))).toBe('2026-W29');
	});

	test('weekly key across year boundary', () => {
		// 2026 starts on Thursday (non-leap) → it has 53 ISO weeks.
		// 2026-12-31 is Thursday → ISO week 53 of 2026.
		// 2027-01-01 is Friday → its Thursday is 2026-12-31 → still week 53 of 2026.
		expect(getWeeklyPeriodKey(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W53');
		expect(getWeeklyPeriodKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
		expect(getWeeklyPeriodKey(new Date('2027-01-04T12:00:00Z'))).toBe('2027-W01');
	});

	test('next daily reset is next UTC midnight', () => {
		const date = new Date('2026-07-26T15:30:00Z');
		const reset = getNextDailyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});

	test('next daily reset at midnight is the following day', () => {
		const date = new Date('2026-07-26T00:00:00Z');
		const reset = getNextDailyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});

	test('next weekly reset is next Monday UTC midnight', () => {
		// 2026-07-26 is Sunday → next Monday is 2026-07-27
		const date = new Date('2026-07-26T12:00:00Z');
		const reset = getNextWeeklyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});

	test('next weekly reset on Monday is the following Monday', () => {
		// 2026-07-20 is Monday → next Monday is 2026-07-27
		const date = new Date('2026-07-20T12:00:00Z');
		const reset = getNextWeeklyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});
});
