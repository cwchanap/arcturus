/**
 * betEvaluator — determines outcome and profit for every active bet after a dice roll
 *
 * Accounting model:
 *   - Bet amounts are deducted from chipBalance when placed
 *   - On WIN:  balance += bet.amount + (bet.odds ?? 0) + evaluation.payout
 *   - On LOSE: no change (already deducted when placed)
 *   - On PUSH: balance += bet.amount + (bet.odds ?? 0)
 *   - evaluation.payout = profit earned (positive for wins, 0 otherwise)
 */

import type { CrapsBet, BetEvaluation, DiceRoll, GamePhase, PointNumber } from './types';
import {
	OFF_DURING_COME_OUT,
	PLACE_PAYOUTS,
	PASS_ODDS_RATIOS,
	DONT_PASS_ODDS_RATIOS,
	BUY_PAYOUTS,
	LAY_PAYOUTS,
	HARDWAY_PAYOUTS,
	PROP_PAYOUTS,
	FIELD_WIN_NUMBERS,
	FIELD_DOUBLE_NUMBERS,
	FIELD_TRIPLE_NUMBERS,
	POINT_NUMBERS,
} from './constants';

// ─── helpers ────────────────────────────────────────────────────────────────

function win(bet: CrapsBet, profit: number): BetEvaluation {
	return { bet, outcome: 'win', payout: profit };
}
function lose(bet: CrapsBet): BetEvaluation {
	return { bet, outcome: 'lose', payout: 0 };
}
function cont(bet: CrapsBet, updatedBet?: CrapsBet): BetEvaluation {
	return { bet, outcome: 'continue', payout: 0, updatedBet };
}

/** Extract the target number from bet types like 'place6', 'buy10', 'hard4' */
function targetNumber(betType: string): number {
	const m = betType.match(/(\d+)$/);
	return m ? parseInt(m[1], 10) : 0;
}

/** True-odds profit for pass/come odds bets */
function passOddsProfit(amount: number, point: PointNumber): number {
	const [num, den] = PASS_ODDS_RATIOS[point];
	return Math.floor((amount * num) / den);
}

/** Lay-odds profit for don't-pass/don't-come odds bets */
function dontPassOddsProfit(amount: number, point: PointNumber): number {
	const [num, den] = DONT_PASS_ODDS_RATIOS[point];
	return Math.floor((amount * num) / den);
}

// ─── individual bet evaluators ───────────────────────────────────────────────

function evalPassLine(
	bet: CrapsBet,
	total: number,
	phase: GamePhase,
	gamePoint: PointNumber | null,
): BetEvaluation {
	if (phase === 'come-out') {
		if (total === 7 || total === 11) return win(bet, bet.amount);
		if (total === 2 || total === 3 || total === 12) return lose(bet);
		return cont(bet); // point established; bet stays active
	}
	// point phase
	if (total === gamePoint) {
		const oddsProfit = bet.odds ? passOddsProfit(bet.odds, gamePoint) : 0;
		return win(bet, bet.amount + oddsProfit);
	}
	if (total === 7) return lose(bet);
	return cont(bet);
}

function evalDontPass(
	bet: CrapsBet,
	total: number,
	phase: GamePhase,
	gamePoint: PointNumber | null,
): BetEvaluation {
	if (phase === 'come-out') {
		if (total === 7 || total === 11) return lose(bet);
		if (total === 2 || total === 3) return win(bet, bet.amount);
		if (total === 12) return cont(bet); // bar 12 (no action)
		return cont(bet); // point established; bet stays active
	}
	if (total === 7) {
		const oddsProfit = bet.odds && gamePoint ? dontPassOddsProfit(bet.odds, gamePoint) : 0;
		return win(bet, bet.amount + oddsProfit);
	}
	if (total === gamePoint) return lose(bet);
	return cont(bet);
}

function evalPassLineOdds(
	bet: CrapsBet,
	total: number,
	phase: GamePhase,
	gamePoint: PointNumber | null,
): BetEvaluation {
	if (phase !== 'point' || !gamePoint) return cont(bet);
	if (total === gamePoint) return win(bet, passOddsProfit(bet.amount, gamePoint));
	if (total === 7) return lose(bet);
	return cont(bet);
}

function evalDontPassOdds(
	bet: CrapsBet,
	total: number,
	phase: GamePhase,
	gamePoint: PointNumber | null,
): BetEvaluation {
	if (phase !== 'point' || !gamePoint) return cont(bet);
	if (total === 7) return win(bet, dontPassOddsProfit(bet.amount, gamePoint));
	if (total === gamePoint) return lose(bet);
	return cont(bet);
}

function evalCome(bet: CrapsBet, total: number): BetEvaluation {
	if (!bet.point) {
		// Pending come bet — this roll is its come-out
		if (total === 7 || total === 11) return win(bet, bet.amount);
		if (total === 2 || total === 3 || total === 12) return lose(bet);
		// Establish come point
		const newPoint = total as PointNumber;
		return cont(bet, { ...bet, point: newPoint });
	}
	// Established come bet
	if (total === bet.point) {
		const oddsProfit = bet.odds ? passOddsProfit(bet.odds, bet.point) : 0;
		return win(bet, bet.amount + oddsProfit);
	}
	if (total === 7) return lose(bet);
	return cont(bet);
}

function evalDontCome(bet: CrapsBet, total: number): BetEvaluation {
	if (!bet.point) {
		if (total === 7 || total === 11) return lose(bet);
		if (total === 2 || total === 3) return win(bet, bet.amount);
		if (total === 12) return cont(bet);
		const newPoint = total as PointNumber;
		return cont(bet, { ...bet, point: newPoint });
	}
	if (total === 7) {
		const oddsProfit = bet.odds ? dontPassOddsProfit(bet.odds, bet.point) : 0;
		return win(bet, bet.amount + oddsProfit);
	}
	if (total === bet.point) return lose(bet);
	return cont(bet);
}

function evalPlace(bet: CrapsBet, total: number, phase: GamePhase): BetEvaluation {
	if (phase === 'come-out') return cont(bet);
	const n = targetNumber(bet.type);
	if (total === n) {
		const [num, den] = PLACE_PAYOUTS[n] ?? [1, 1];
		return win(bet, Math.floor((bet.amount * num) / den));
	}
	if (total === 7) return lose(bet);
	return cont(bet);
}

function evalField(bet: CrapsBet, total: number): BetEvaluation {
	if (FIELD_DOUBLE_NUMBERS.has(total)) return win(bet, bet.amount * 2);
	if (FIELD_TRIPLE_NUMBERS.has(total)) return win(bet, bet.amount * 3);
	if (FIELD_WIN_NUMBERS.has(total)) return win(bet, bet.amount);
	return lose(bet); // 5, 6, 7, 8 lose
}

function evalBig(bet: CrapsBet, total: number, target: number): BetEvaluation {
	if (total === target) return win(bet, bet.amount);
	if (total === 7) return lose(bet);
	return cont(bet);
}

function evalBuy(bet: CrapsBet, total: number, phase: GamePhase): BetEvaluation {
	if (phase === 'come-out') return cont(bet);
	const n = targetNumber(bet.type);
	if (total === n) {
		const [num, den] = BUY_PAYOUTS[n] ?? [1, 1];
		return win(bet, Math.floor((bet.amount * num) / den));
	}
	if (total === 7) return lose(bet);
	return cont(bet);
}

function evalLay(bet: CrapsBet, total: number, phase: GamePhase): BetEvaluation {
	if (phase === 'come-out') return cont(bet);
	const n = targetNumber(bet.type);
	if (total === 7) {
		const [num, den] = LAY_PAYOUTS[n] ?? [1, 1];
		return win(bet, Math.floor((bet.amount * num) / den));
	}
	if (total === n) return lose(bet);
	return cont(bet);
}

function evalHardway(
	bet: CrapsBet,
	total: number,
	isHard: boolean,
	phase: GamePhase,
): BetEvaluation {
	if (phase === 'come-out') return cont(bet);
	const n = targetNumber(bet.type);
	if (total === n && isHard) return win(bet, bet.amount * (HARDWAY_PAYOUTS[n] ?? 7));
	// Lose on easy way (same total, not hard) or on 7
	if (total === n || total === 7) return lose(bet);
	return cont(bet);
}

// ─── main export ─────────────────────────────────────────────────────────────

export function evaluateBets(
	bets: CrapsBet[],
	roll: DiceRoll,
	phase: GamePhase,
	gamePoint: PointNumber | null,
): BetEvaluation[] {
	return bets.map((bet) => evaluateBet(bet, roll, phase, gamePoint));
}

function evaluateBet(
	bet: CrapsBet,
	roll: DiceRoll,
	phase: GamePhase,
	gamePoint: PointNumber | null,
): BetEvaluation {
	const { total } = roll;
	const isHard = roll.die1 === roll.die2;

	// Bets that are off (don't resolve) during come-out
	if (phase === 'come-out' && OFF_DURING_COME_OUT.has(bet.type)) {
		return cont(bet);
	}

	switch (bet.type) {
		case 'passLine':
			return evalPassLine(bet, total, phase, gamePoint);
		case 'dontPass':
			return evalDontPass(bet, total, phase, gamePoint);
		case 'passLineOdds':
			return evalPassLineOdds(bet, total, phase, gamePoint);
		case 'dontPassOdds':
			return evalDontPassOdds(bet, total, phase, gamePoint);
		case 'come':
			return evalCome(bet, total);
		case 'dontCome':
			return evalDontCome(bet, total);
		case 'place4':
		case 'place5':
		case 'place6':
		case 'place8':
		case 'place9':
		case 'place10':
			return evalPlace(bet, total, phase);
		case 'field':
			return evalField(bet, total);
		case 'big6':
			return evalBig(bet, total, 6);
		case 'big8':
			return evalBig(bet, total, 8);
		case 'buy4':
		case 'buy5':
		case 'buy6':
		case 'buy8':
		case 'buy9':
		case 'buy10':
			return evalBuy(bet, total, phase);
		case 'lay4':
		case 'lay5':
		case 'lay6':
		case 'lay8':
		case 'lay9':
		case 'lay10':
			return evalLay(bet, total, phase);
		case 'hard4':
		case 'hard6':
		case 'hard8':
		case 'hard10':
			return evalHardway(bet, total, isHard, phase);
		case 'any7':
			return total === 7 ? win(bet, bet.amount * PROP_PAYOUTS.any7) : lose(bet);
		case 'anyCraps':
			return [2, 3, 12].includes(total) ? win(bet, bet.amount * PROP_PAYOUTS.anyCraps) : lose(bet);
		case 'aceDeuce':
			return total === 3 ? win(bet, bet.amount * PROP_PAYOUTS.aceDeuce) : lose(bet);
		case 'aces':
			return total === 2 ? win(bet, bet.amount * PROP_PAYOUTS.aces) : lose(bet);
		case 'boxcars':
			return total === 12 ? win(bet, bet.amount * PROP_PAYOUTS.boxcars) : lose(bet);
		case 'yo':
			return total === 11 ? win(bet, bet.amount * PROP_PAYOUTS.yo) : lose(bet);
		case 'ce':
			if ([2, 3, 12].includes(total)) return win(bet, bet.amount * PROP_PAYOUTS.ceCraps);
			if (total === 11) return win(bet, bet.amount * PROP_PAYOUTS.ceYo);
			return lose(bet);
		default:
			return cont(bet);
	}
}

/** Compute total chips won/lost across all resolved bets in this evaluation set */
export function computeNetDelta(evaluations: BetEvaluation[]): number {
	let delta = 0;
	for (const ev of evaluations) {
		if (ev.outcome === 'win') {
			delta += ev.payout; // profit only (bet.amount returned separately by CrapsGame)
		} else if (ev.outcome === 'lose') {
			delta -= ev.bet.amount + (ev.bet.odds ?? 0);
		}
		// push and continue: 0
	}
	return delta;
}

/** All point numbers as a type guard */
export function isPointNumber(n: number): n is PointNumber {
	return POINT_NUMBERS.has(n);
}
