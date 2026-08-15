/**
 * Unit tests for Sic Bo payout rules
 */

import { describe, expect, test } from 'bun:test';
import {
	getBetOdds,
	isSupportedBetKey,
	isWinningBet,
	resolveBet,
	SIC_BO_CHIP_DENOMINATIONS,
	TOTAL_ODDS,
} from './rules';

describe('SIC_BO_CHIP_DENOMINATIONS', () => {
	test('matches the fixed chip denominations', () => {
		expect(SIC_BO_CHIP_DENOMINATIONS).toEqual([1, 5, 10, 25, 50, 100]);
	});
});

describe('isWinningBet', () => {
	test('big/small lose on every triple', () => {
		expect(isWinningBet('big', [5, 5, 5])).toBe(false);
		expect(isWinningBet('small', [2, 2, 2])).toBe(false);
	});

	test('odd/even lose on every triple', () => {
		expect(isWinningBet('odd', [3, 3, 3])).toBe(false);
		expect(isWinningBet('even', [4, 4, 4])).toBe(false);
	});

	test('small wins on totals 4-10', () => {
		expect(isWinningBet('small', [1, 2, 3])).toBe(true);
		expect(isWinningBet('small', [3, 3, 4])).toBe(true);
	});

	test('big wins on totals 11-17', () => {
		expect(isWinningBet('big', [5, 6, 6])).toBe(true);
	});

	test('odd wins on odd totals, even wins on even totals', () => {
		expect(isWinningBet('odd', [1, 2, 4])).toBe(true);
		expect(isWinningBet('even', [1, 2, 3])).toBe(true);
	});

	test('any-triple wins only on triples', () => {
		expect(isWinningBet('any-triple', [6, 6, 6])).toBe(true);
		expect(isWinningBet('any-triple', [1, 1, 2])).toBe(false);
	});

	test('exact totals win when the roll matches the total', () => {
		expect(isWinningBet('total:4', [1, 1, 2])).toBe(true);
		expect(isWinningBet('total:4', [1, 1, 3])).toBe(false);
		expect(isWinningBet('total:17', [5, 6, 6])).toBe(true);
	});
});

describe('getBetOdds / TOTAL_ODDS', () => {
	test('symmetric exact-total odds match Paytable A', () => {
		expect(getBetOdds('total:4')).toBe(50);
		expect(getBetOdds('total:5')).toBe(18);
		expect(getBetOdds('total:6')).toBe(14);
		expect(getBetOdds('total:7')).toBe(12);
		expect(getBetOdds('total:8')).toBe(8);
		expect(getBetOdds('total:9')).toBe(6);
		expect(getBetOdds('total:10')).toBe(6);
		expect(getBetOdds('total:11')).toBe(6);
		expect(getBetOdds('total:12')).toBe(6);
		expect(getBetOdds('total:13')).toBe(8);
		expect(getBetOdds('total:14')).toBe(12);
		expect(getBetOdds('total:15')).toBe(14);
		expect(getBetOdds('total:16')).toBe(18);
		expect(getBetOdds('total:17')).toBe(50);
	});

	test('big/small/odd/even/any-triple odds', () => {
		expect(getBetOdds('big')).toBe(1);
		expect(getBetOdds('small')).toBe(1);
		expect(getBetOdds('odd')).toBe(1);
		expect(getBetOdds('even')).toBe(1);
		expect(getBetOdds('any-triple')).toBe(24);
	});

	test('TOTAL_ODDS table entries match getBetOdds', () => {
		for (const [total, odds] of Object.entries(TOTAL_ODDS) as unknown as Array<
			[keyof typeof TOTAL_ODDS, number]
		>) {
			expect(getBetOdds(`total:${total}`)).toBe(odds);
		}
	});
});

describe('resolveBet', () => {
	test('winning exact-total gross return is amount * (odds + 1)', () => {
		expect(resolveBet({ key: 'total:4', amount: 2 }, [1, 1, 2]).grossReturn).toBe(102);
	});

	test('winning even-money bet doubles the stake', () => {
		expect(resolveBet({ key: 'small', amount: 5 }, [1, 2, 3]).grossReturn).toBe(10);
	});

	test('winning any-triple pays amount * 25', () => {
		expect(resolveBet({ key: 'any-triple', amount: 1 }, [6, 6, 6]).grossReturn).toBe(25);
	});

	test('losing bet gross return is 0', () => {
		expect(resolveBet({ key: 'big', amount: 10 }, [5, 5, 5]).grossReturn).toBe(0);
	});

	test('result exposes key, amount, odds, and won flag', () => {
		expect(resolveBet({ key: 'total:9', amount: 4 }, [2, 3, 4])).toEqual({
			key: 'total:9',
			amount: 4,
			odds: 6,
			won: true,
			grossReturn: 28,
		});
		expect(resolveBet({ key: 'total:9', amount: 4 }, [2, 3, 3])).toEqual({
			key: 'total:9',
			amount: 4,
			odds: 6,
			won: false,
			grossReturn: 0,
		});
	});
});

describe('isSupportedBetKey', () => {
	test('accepts primary keys and valid exact totals', () => {
		expect(isSupportedBetKey('big')).toBe(true);
		expect(isSupportedBetKey('small')).toBe(true);
		expect(isSupportedBetKey('odd')).toBe(true);
		expect(isSupportedBetKey('even')).toBe(true);
		expect(isSupportedBetKey('any-triple')).toBe(true);
		expect(isSupportedBetKey('total:4')).toBe(true);
		expect(isSupportedBetKey('total:17')).toBe(true);
	});

	test('rejects forged totals outside 4-17', () => {
		expect(isSupportedBetKey('total:3')).toBe(false);
		expect(isSupportedBetKey('total:18')).toBe(false);
		expect(isSupportedBetKey('total:0')).toBe(false);
		expect(isSupportedBetKey('total:99')).toBe(false);
	});

	test('rejects unknown keys and malformed totals', () => {
		expect(isSupportedBetKey('doubles')).toBe(false);
		expect(isSupportedBetKey('total:')).toBe(false);
		expect(isSupportedBetKey('total:abc')).toBe(false);
		expect(isSupportedBetKey('')).toBe(false);
	});

	test('rejects non-canonical total suffixes that Number() would coerce', () => {
		expect(isSupportedBetKey('total:04')).toBe(false); // leading zero
		expect(isSupportedBetKey('total:4.0')).toBe(false); // decimal
		expect(isSupportedBetKey('total:4e0')).toBe(false); // exponent
		expect(isSupportedBetKey('total:0x4')).toBe(false); // hex
		expect(isSupportedBetKey('total:+4')).toBe(false); // sign
		expect(isSupportedBetKey('total: 4 ')).toBe(false); // whitespace
		expect(isSupportedBetKey('total: 4')).toBe(false); // leading whitespace
	});
});

describe('forged bet key rejection', () => {
	test('getBetOdds throws on forged totals instead of returning NaN', () => {
		expect(() => getBetOdds('total:3' as never)).toThrow();
		expect(() => getBetOdds('total:18' as never)).toThrow();
		expect(() => getBetOdds('doubles' as never)).toThrow();
	});

	test('isWinningBet throws on forged totals instead of producing a result', () => {
		expect(() => isWinningBet('total:3' as never, [1, 1, 1])).toThrow();
		expect(() => isWinningBet('total:18' as never, [6, 6, 6])).toThrow();
	});

	test('resolveBet throws on forged keys so no NaN grossReturn is produced', () => {
		expect(() => resolveBet({ key: 'total:3' as never, amount: 10 }, [1, 1, 1])).toThrow();
		expect(() => resolveBet({ key: 'total:18' as never, amount: 10 }, [6, 6, 6])).toThrow();
	});
});
