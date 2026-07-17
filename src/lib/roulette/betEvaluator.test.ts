import { describe, expect, it } from 'bun:test';
import { doesBetWin, evaluateBets } from './betEvaluator';
import type { RouletteBet } from './types';

function makeBet(type: RouletteBet['type'], amount: number, target?: number): RouletteBet {
	return {
		id: 'test-' + type + '-' + (target ?? ''),
		type,
		amount,
		...(target !== undefined ? { target } : {}),
	};
}

describe('doesBetWin', () => {
	describe('straight-up bets', () => {
		for (let n = 0; n <= 36; n++) {
			it(`number ${n} wins on straight-${n}`, () => {
				expect(doesBetWin(makeBet('straight', 1, n), n)).toBe(true);
			});
			it(`number ${n} loses on straight-${(n + 1) % 37}`, () => {
				const other = (n + 1) % 37;
				if (other !== n) {
					expect(doesBetWin(makeBet('straight', 1, n), other)).toBe(false);
				}
			});
		}
	});

	describe('red/black', () => {
		it('red wins on a red number (1)', () => {
			expect(doesBetWin(makeBet('red', 1), 1)).toBe(true);
		});
		it('red loses on a black number (2)', () => {
			expect(doesBetWin(makeBet('red', 1), 2)).toBe(false);
		});
		it('red loses on 0', () => {
			expect(doesBetWin(makeBet('red', 1), 0)).toBe(false);
		});
		it('black wins on a black number (2)', () => {
			expect(doesBetWin(makeBet('black', 1), 2)).toBe(true);
		});
		it('black loses on 0', () => {
			expect(doesBetWin(makeBet('black', 1), 0)).toBe(false);
		});
	});

	describe('odd/even', () => {
		it('odd wins on 1', () => {
			expect(doesBetWin(makeBet('odd', 1), 1)).toBe(true);
		});
		it('odd wins on 35', () => {
			expect(doesBetWin(makeBet('odd', 1), 35)).toBe(true);
		});
		it('odd loses on 2', () => {
			expect(doesBetWin(makeBet('odd', 1), 2)).toBe(false);
		});
		it('odd loses on 0', () => {
			expect(doesBetWin(makeBet('odd', 1), 0)).toBe(false);
		});
		it('even wins on 2', () => {
			expect(doesBetWin(makeBet('even', 1), 2)).toBe(true);
		});
		it('even loses on 0', () => {
			expect(doesBetWin(makeBet('even', 1), 0)).toBe(false);
		});
	});

	describe('low/high', () => {
		it('low wins on 1', () => {
			expect(doesBetWin(makeBet('low', 1), 1)).toBe(true);
		});
		it('low wins on 18', () => {
			expect(doesBetWin(makeBet('low', 1), 18)).toBe(true);
		});
		it('low loses on 19', () => {
			expect(doesBetWin(makeBet('low', 1), 19)).toBe(false);
		});
		it('low loses on 0', () => {
			expect(doesBetWin(makeBet('low', 1), 0)).toBe(false);
		});
		it('high wins on 19', () => {
			expect(doesBetWin(makeBet('high', 1), 19)).toBe(true);
		});
		it('high wins on 36', () => {
			expect(doesBetWin(makeBet('high', 1), 36)).toBe(true);
		});
		it('high loses on 18', () => {
			expect(doesBetWin(makeBet('high', 1), 18)).toBe(false);
		});
		it('high loses on 0', () => {
			expect(doesBetWin(makeBet('high', 1), 0)).toBe(false);
		});
	});

	describe('dozen', () => {
		it('1st dozen (target=0) wins on 1', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 1)).toBe(true);
		});
		it('1st dozen wins on 12', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 12)).toBe(true);
		});
		it('1st dozen loses on 13', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 13)).toBe(false);
		});
		it('2nd dozen (target=1) wins on 13', () => {
			expect(doesBetWin(makeBet('dozen', 1, 1), 13)).toBe(true);
		});
		it('2nd dozen wins on 24', () => {
			expect(doesBetWin(makeBet('dozen', 1, 1), 24)).toBe(true);
		});
		it('2nd dozen loses on 25', () => {
			expect(doesBetWin(makeBet('dozen', 1, 1), 25)).toBe(false);
		});
		it('3rd dozen (target=2) wins on 25', () => {
			expect(doesBetWin(makeBet('dozen', 1, 2), 25)).toBe(true);
		});
		it('3rd dozen wins on 36', () => {
			expect(doesBetWin(makeBet('dozen', 1, 2), 36)).toBe(true);
		});
		it('all dozens lose on 0', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 0)).toBe(false);
			expect(doesBetWin(makeBet('dozen', 1, 1), 0)).toBe(false);
			expect(doesBetWin(makeBet('dozen', 1, 2), 0)).toBe(false);
		});
	});

	describe('column', () => {
		it('column 0 wins on 3 (n%3===0)', () => {
			expect(doesBetWin(makeBet('column', 1, 0), 3)).toBe(true);
		});
		it('column 0 wins on 36', () => {
			expect(doesBetWin(makeBet('column', 1, 0), 36)).toBe(true);
		});
		it('column 1 wins on 2 (n%3===2)', () => {
			expect(doesBetWin(makeBet('column', 1, 1), 2)).toBe(true);
		});
		it('column 1 wins on 35', () => {
			expect(doesBetWin(makeBet('column', 1, 1), 35)).toBe(true);
		});
		it('column 2 wins on 1 (n%3===1)', () => {
			expect(doesBetWin(makeBet('column', 1, 2), 1)).toBe(true);
		});
		it('column 2 wins on 34', () => {
			expect(doesBetWin(makeBet('column', 1, 2), 34)).toBe(true);
		});
		it('all columns lose on 0', () => {
			expect(doesBetWin(makeBet('column', 1, 0), 0)).toBe(false);
			expect(doesBetWin(makeBet('column', 1, 1), 0)).toBe(false);
			expect(doesBetWin(makeBet('column', 1, 2), 0)).toBe(false);
		});
	});

	describe('zero handling', () => {
		it('straight-up 0 wins on 0', () => {
			expect(doesBetWin(makeBet('straight', 1, 0), 0)).toBe(true);
		});
		it('straight-up non-zero loses on 0', () => {
			expect(doesBetWin(makeBet('straight', 1, 17), 0)).toBe(false);
		});
	});
});

describe('evaluateBets', () => {
	it('returns payout for a winning straight bet (35:1)', () => {
		const results = evaluateBets([makeBet('straight', 10, 17)], 17);
		expect(results).toHaveLength(1);
		expect(results[0].won).toBe(true);
		expect(results[0].payout).toBe(360); // 10 * (35 + 1)
	});

	it('returns 0 payout for a losing straight bet', () => {
		const results = evaluateBets([makeBet('straight', 10, 17)], 18);
		expect(results[0].won).toBe(false);
		expect(results[0].payout).toBe(0);
	});

	it('returns payout for a winning red bet (1:1)', () => {
		const results = evaluateBets([makeBet('red', 50)], 1);
		expect(results[0].won).toBe(true);
		expect(results[0].payout).toBe(100); // 50 * (1 + 1)
	});

	it('returns payout for a winning dozen bet (2:1)', () => {
		const results = evaluateBets([makeBet('dozen', 50, 0)], 5);
		expect(results[0].won).toBe(true);
		expect(results[0].payout).toBe(150); // 50 * (2 + 1)
	});

	it('handles mixed wins and losses on the same spin', () => {
		const bets = [
			makeBet('straight', 10, 17),
			makeBet('red', 50),
			makeBet('black', 50),
			makeBet('odd', 25),
		];
		const results = evaluateBets(bets, 17); // 17 is black and odd
		expect(results).toHaveLength(4);
		expect(results[0].won).toBe(true); // straight 17
		expect(results[0].payout).toBe(360);
		expect(results[1].won).toBe(false); // red loses (17 is black)
		expect(results[1].payout).toBe(0);
		expect(results[2].won).toBe(true); // black wins (17 is black)
		expect(results[2].payout).toBe(100);
		expect(results[3].won).toBe(true); // odd
		expect(results[3].payout).toBe(50);
	});

	it('all bets lose on 0 except straight-0', () => {
		const bets = [
			makeBet('straight', 10, 0),
			makeBet('red', 50),
			makeBet('odd', 25),
			makeBet('dozen', 50, 0),
		];
		const results = evaluateBets(bets, 0);
		expect(results[0].won).toBe(true); // straight 0
		expect(results[0].payout).toBe(360);
		expect(results[1].won).toBe(false); // red
		expect(results[2].won).toBe(false); // odd
		expect(results[3].won).toBe(false); // dozen
	});

	it('net delta = totalPayout - totalBet', () => {
		const bets = [makeBet('straight', 10, 17), makeBet('black', 50)];
		const results = evaluateBets(bets, 17);
		const totalPayout = results.reduce((s, r) => s + r.payout, 0);
		const totalBet = bets.reduce((s, b) => s + b.amount, 0);
		expect(totalPayout).toBe(460); // 360 + 100
		expect(totalBet).toBe(60); // 10 + 50
		expect(totalPayout - totalBet).toBe(400); // net gain
	});
});

describe('doesBetWin — unknown bet types', () => {
	it('returns false for an unknown/invalid bet type', () => {
		const unknownBet = makeBet('red' as RouletteBet['type'], 10);
		// Cast to an invalid type to trigger the default case
		(unknownBet as { type: string }).type = 'unknown-type';
		expect(doesBetWin(unknownBet as RouletteBet, 17)).toBe(false);
	});
});
