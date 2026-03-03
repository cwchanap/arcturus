import { describe, test, expect } from 'bun:test';
import { evaluateBets, computeNetDelta } from './betEvaluator';
import { createRoll } from './diceRoller';
import type { CrapsBet } from './types';

let idSeq = 0;
function bet(type: CrapsBet['type'], amount: number, extra?: Partial<CrapsBet>): CrapsBet {
	return { id: `t${++idSeq}`, type, amount, ...extra };
}

// ─── Pass Line ────────────────────────────────────────────────────────────────

describe('Pass Line — come-out phase', () => {
	test('wins on natural 7', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(3, 4), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(50);
	});

	test('wins on natural 11', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(5, 6), 'come-out', null);
		expect(ev.outcome).toBe('win');
	});

	test('loses on 2', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(1, 1), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});

	test('loses on 3', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(1, 2), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});

	test('loses on 12', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(6, 6), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});

	test('continues on point number', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(3, 3), 'come-out', null); // 6
		expect(ev.outcome).toBe('continue');
	});
});

describe('Pass Line — point phase', () => {
	test('wins when point is rolled', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(3, 3), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(50);
	});

	test('loses on 7', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(3, 4), 'point', 6);
		expect(ev.outcome).toBe('lose');
	});

	test('continues on other roll', () => {
		const [ev] = evaluateBets([bet('passLine', 50)], createRoll(2, 3), 'point', 6); // 5
		expect(ev.outcome).toBe('continue');
	});
});

// ─── Don't Pass ───────────────────────────────────────────────────────────────

describe("Don't Pass", () => {
	test('loses on 7 during come-out', () => {
		const [ev] = evaluateBets([bet('dontPass', 50)], createRoll(3, 4), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});

	test('wins on 2 during come-out', () => {
		const [ev] = evaluateBets([bet('dontPass', 50)], createRoll(1, 1), 'come-out', null);
		expect(ev.outcome).toBe('win');
	});

	test('pushes on 12 during come-out', () => {
		const [ev] = evaluateBets([bet('dontPass', 50)], createRoll(6, 6), 'come-out', null);
		expect(ev.outcome).toBe('push');
	});

	test('wins on 7 during point phase', () => {
		const [ev] = evaluateBets([bet('dontPass', 50)], createRoll(3, 4), 'point', 8);
		expect(ev.outcome).toBe('win');
	});

	test('loses when point rolled during point phase', () => {
		const [ev] = evaluateBets([bet('dontPass', 50)], createRoll(4, 4), 'point', 8);
		expect(ev.outcome).toBe('lose');
	});
});

// ─── Pass Line Odds ───────────────────────────────────────────────────────────

describe('Pass Line Odds', () => {
	test('wins 2:1 when point 4 is rolled', () => {
		const [ev] = evaluateBets([bet('passLineOdds', 100)], createRoll(2, 2), 'point', 4);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(200);
	});

	test('wins 6:5 when point 6 is rolled', () => {
		const [ev] = evaluateBets([bet('passLineOdds', 50)], createRoll(3, 3), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(60); // floor(50 * 6/5) = 60
	});

	test('wins 3:2 when point 5 is rolled', () => {
		const [ev] = evaluateBets([bet('passLineOdds', 100)], createRoll(2, 3), 'point', 5);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(150);
	});

	test('loses on 7', () => {
		const [ev] = evaluateBets([bet('passLineOdds', 100)], createRoll(3, 4), 'point', 6);
		expect(ev.outcome).toBe('lose');
	});

	test('continues during come-out', () => {
		const [ev] = evaluateBets([bet('passLineOdds', 100)], createRoll(3, 4), 'come-out', null);
		expect(ev.outcome).toBe('continue');
	});
});

// ─── Come bet ─────────────────────────────────────────────────────────────────

describe('Come bet (no point)', () => {
	test('wins on 7', () => {
		const [ev] = evaluateBets([bet('come', 50)], createRoll(3, 4), 'point', 8);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(50);
	});

	test('wins on 11', () => {
		const [ev] = evaluateBets([bet('come', 50)], createRoll(5, 6), 'point', 8);
		expect(ev.outcome).toBe('win');
	});

	test('loses on 2', () => {
		const [ev] = evaluateBets([bet('come', 50)], createRoll(1, 1), 'point', 8);
		expect(ev.outcome).toBe('lose');
	});

	test('establishes come point on 4', () => {
		const [ev] = evaluateBets([bet('come', 50)], createRoll(1, 3), 'point', 8);
		expect(ev.outcome).toBe('continue');
		expect(ev.updatedBet?.point).toBe(4);
	});

	test('establishes come point on 9', () => {
		const [ev] = evaluateBets([bet('come', 50)], createRoll(4, 5), 'point', 8);
		expect(ev.outcome).toBe('continue');
		expect(ev.updatedBet?.point).toBe(9);
	});
});

describe('Come bet (with established point)', () => {
	test('wins when come point is rolled', () => {
		const b = bet('come', 50, { point: 6 });
		const [ev] = evaluateBets([b], createRoll(3, 3), 'point', 8);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(50); // 1:1 on bet, no odds
	});

	test('wins with odds when come point is rolled', () => {
		const b = bet('come', 50, { point: 6, odds: 100 });
		const [ev] = evaluateBets([b], createRoll(3, 3), 'point', 8);
		expect(ev.outcome).toBe('win');
		// profit = 50 (1:1 on bet) + floor(100 * 6/5) = 50 + 120 = 170
		expect(ev.payout).toBe(170);
	});

	test('loses on 7', () => {
		const b = bet('come', 50, { point: 6 });
		const [ev] = evaluateBets([b], createRoll(3, 4), 'point', 8);
		expect(ev.outcome).toBe('lose');
	});

	test('continues on other roll', () => {
		const b = bet('come', 50, { point: 6 });
		const [ev] = evaluateBets([b], createRoll(2, 3), 'point', 8); // 5
		expect(ev.outcome).toBe('continue');
	});
});

// ─── Place bets ───────────────────────────────────────────────────────────────

describe('Place bets', () => {
	test('Place 6 wins 7:6 when 6 is rolled', () => {
		const [ev] = evaluateBets([bet('place6', 60)], createRoll(3, 3), 'point', 8);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70); // floor(60 * 7/6) = 70
	});

	test('Place 8 wins 7:6 when 8 is rolled', () => {
		const [ev] = evaluateBets([bet('place8', 60)], createRoll(4, 4), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70);
	});

	test('Place 5 wins 7:5 when 5 is rolled', () => {
		const [ev] = evaluateBets([bet('place5', 50)], createRoll(2, 3), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70); // floor(50 * 7/5) = 70
	});

	test('Place 4 wins 9:5 when 4 is rolled', () => {
		const [ev] = evaluateBets([bet('place4', 50)], createRoll(2, 2), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(90); // floor(50 * 9/5) = 90
	});

	test('Place bet loses on 7', () => {
		const [ev] = evaluateBets([bet('place6', 60)], createRoll(3, 4), 'point', 8);
		expect(ev.outcome).toBe('lose');
	});

	test('Place bet is OFF during come-out', () => {
		const [ev] = evaluateBets([bet('place6', 60)], createRoll(3, 3), 'come-out', null);
		expect(ev.outcome).toBe('continue');
	});
});

// ─── Field ────────────────────────────────────────────────────────────────────

describe('Field bet', () => {
	test('pays even money on 9', () => {
		const [ev] = evaluateBets([bet('field', 50)], createRoll(4, 5), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(50);
	});

	test('pays 2:1 on 2', () => {
		const [ev] = evaluateBets([bet('field', 50)], createRoll(1, 1), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(100);
	});

	test('pays 3:1 on 12', () => {
		const [ev] = evaluateBets([bet('field', 50)], createRoll(6, 6), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(150);
	});

	test('loses on 7', () => {
		const [ev] = evaluateBets([bet('field', 50)], createRoll(3, 4), 'point', 6);
		expect(ev.outcome).toBe('lose');
	});

	test('loses on 5', () => {
		const [ev] = evaluateBets([bet('field', 50)], createRoll(2, 3), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});

	test('loses on 8', () => {
		const [ev] = evaluateBets([bet('field', 50)], createRoll(4, 4), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});
});

// ─── Hardways ─────────────────────────────────────────────────────────────────

describe('Hardway bets', () => {
	test('Hard 6 wins 9:1 on hard 6', () => {
		const [ev] = evaluateBets([bet('hard6', 20)], createRoll(3, 3), 'point', 8);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(180);
	});

	test('Hard 6 loses on easy 6', () => {
		const [ev] = evaluateBets([bet('hard6', 20)], createRoll(2, 4), 'point', 8);
		expect(ev.outcome).toBe('lose');
	});

	test('Hard 6 loses on 7', () => {
		const [ev] = evaluateBets([bet('hard6', 20)], createRoll(3, 4), 'point', 8);
		expect(ev.outcome).toBe('lose');
	});

	test('Hard 8 wins 9:1 on hard 8', () => {
		const [ev] = evaluateBets([bet('hard8', 20)], createRoll(4, 4), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(180);
	});

	test('Hard 4 wins 7:1', () => {
		const [ev] = evaluateBets([bet('hard4', 10)], createRoll(2, 2), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70);
	});

	test('Hard 10 wins 7:1', () => {
		const [ev] = evaluateBets([bet('hard10', 10)], createRoll(5, 5), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70);
	});

	test('Hardway is OFF during come-out', () => {
		const [ev] = evaluateBets([bet('hard6', 20)], createRoll(3, 3), 'come-out', null);
		expect(ev.outcome).toBe('continue');
	});

	test('Hardway continues on unrelated roll', () => {
		const [ev] = evaluateBets([bet('hard6', 20)], createRoll(2, 3), 'point', 8);
		expect(ev.outcome).toBe('continue');
	});
});

// ─── Prop bets ────────────────────────────────────────────────────────────────

describe('Proposition bets', () => {
	test('Any 7 wins 4:1 on 7', () => {
		const [ev] = evaluateBets([bet('any7', 10)], createRoll(3, 4), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(40);
	});

	test('Any 7 loses on non-7', () => {
		const [ev] = evaluateBets([bet('any7', 10)], createRoll(3, 3), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});

	test('Any Craps wins 7:1 on 2', () => {
		const [ev] = evaluateBets([bet('anyCraps', 10)], createRoll(1, 1), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70);
	});

	test('Yo wins 15:1 on 11', () => {
		const [ev] = evaluateBets([bet('yo', 10)], createRoll(5, 6), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(150);
	});

	test('Aces (2) wins 30:1', () => {
		const [ev] = evaluateBets([bet('aces', 5)], createRoll(1, 1), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(150);
	});

	test('Boxcars (12) wins 30:1', () => {
		const [ev] = evaluateBets([bet('boxcars', 5)], createRoll(6, 6), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(150);
	});

	test('C&E wins 3:1 on craps', () => {
		const [ev] = evaluateBets([bet('ce', 10)], createRoll(1, 2), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(30);
	});

	test('C&E wins 7:1 on yo', () => {
		const [ev] = evaluateBets([bet('ce', 10)], createRoll(5, 6), 'come-out', null);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(70);
	});

	test('C&E loses on 7', () => {
		const [ev] = evaluateBets([bet('ce', 10)], createRoll(3, 4), 'come-out', null);
		expect(ev.outcome).toBe('lose');
	});
});

// ─── Buy / Lay ────────────────────────────────────────────────────────────────

describe('Buy bets', () => {
	test('Buy 4 pays 1.9:1 (2:1 minus vig)', () => {
		const [ev] = evaluateBets([bet('buy4', 100)], createRoll(2, 2), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(190); // floor(100 * 19/10)
	});

	test('Buy 6 pays 1.14:1 (6:5 minus vig)', () => {
		const [ev] = evaluateBets([bet('buy6', 50)], createRoll(3, 3), 'point', 8);
		expect(ev.outcome).toBe('win');
		// floor(50 * 57/50) = floor(57) = 57
		expect(ev.payout).toBe(57);
	});

	test('Buy bet is OFF during come-out', () => {
		const [ev] = evaluateBets([bet('buy4', 100)], createRoll(2, 2), 'come-out', null);
		expect(ev.outcome).toBe('continue');
	});
});

describe('Lay bets', () => {
	test('Lay 4 wins on 7 (0.475:1)', () => {
		const [ev] = evaluateBets([bet('lay4', 100)], createRoll(3, 4), 'point', 6);
		expect(ev.outcome).toBe('win');
		expect(ev.payout).toBe(47); // floor(100 * 19/40)
	});

	test('Lay 6 wins on 7', () => {
		const [ev] = evaluateBets([bet('lay6', 100)], createRoll(3, 4), 'point', 8);
		expect(ev.outcome).toBe('win');
		// floor(100 * 19/24) = floor(79.17) = 79
		expect(ev.payout).toBe(79);
	});

	test('Lay 4 loses when 4 is rolled', () => {
		const [ev] = evaluateBets([bet('lay4', 100)], createRoll(2, 2), 'point', 6);
		expect(ev.outcome).toBe('lose');
	});

	test('Lay bet is OFF during come-out', () => {
		const [ev] = evaluateBets([bet('lay4', 100)], createRoll(3, 4), 'come-out', null);
		expect(ev.outcome).toBe('continue');
	});
});

// ─── computeNetDelta ─────────────────────────────────────────────────────────

describe('computeNetDelta', () => {
	test('win contributes positive profit', () => {
		const evs = evaluateBets([bet('passLine', 50)], createRoll(3, 4), 'come-out', null);
		expect(computeNetDelta(evs)).toBe(50);
	});

	test('lose contributes negative bet amount', () => {
		const evs = evaluateBets([bet('any7', 10)], createRoll(1, 1), 'come-out', null);
		expect(computeNetDelta(evs)).toBe(-10);
	});

	test('push contributes 0', () => {
		const evs = evaluateBets([bet('dontPass', 50)], createRoll(6, 6), 'come-out', null);
		expect(computeNetDelta(evs)).toBe(0);
	});

	test('mixed bets sum correctly', () => {
		const bets = [
			bet('passLine', 50), // wins +50
			bet('field', 50), // loses on 7 → actually roll isn't 7... let's use 3+4=7
		];
		// Roll 7 during come-out: passLine wins, field loses
		const evs = evaluateBets(bets, createRoll(3, 4), 'come-out', null);
		// passLine win: +50, field lose: -50
		expect(computeNetDelta(evs)).toBe(0);
	});
});
