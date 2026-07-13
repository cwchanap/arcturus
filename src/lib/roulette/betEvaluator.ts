import type { BetResult, RouletteBet } from './types';
import { BLACK_NUMBERS, PAYOUT_MULTIPLIERS, RED_NUMBERS } from './constants';

export function columnIndexToMod3(index: number): number {
	return [0, 2, 1][index];
}

export function doesBetWin(bet: RouletteBet, winningNumber: number): boolean {
	if (winningNumber === 0) {
		return bet.type === 'straight' && bet.target === 0;
	}
	switch (bet.type) {
		case 'straight':
			return bet.target === winningNumber;
		case 'red':
			return RED_NUMBERS.has(winningNumber);
		case 'black':
			return BLACK_NUMBERS.has(winningNumber);
		case 'odd':
			return winningNumber % 2 === 1;
		case 'even':
			return winningNumber % 2 === 0;
		case 'low':
			return winningNumber >= 1 && winningNumber <= 18;
		case 'high':
			return winningNumber >= 19 && winningNumber <= 36;
		case 'dozen':
			return Math.ceil(winningNumber / 12) === bet.target! + 1;
		case 'column':
			return winningNumber % 3 === columnIndexToMod3(bet.target!);
		default:
			return false;
	}
}

export function evaluateBets(bets: RouletteBet[], winningNumber: number): BetResult[] {
	return bets.map((bet) => {
		const won = doesBetWin(bet, winningNumber);
		const multiplier = PAYOUT_MULTIPLIERS[bet.type];
		return {
			bet,
			won,
			payout: won ? bet.amount * (multiplier + 1) : 0,
		};
	});
}
