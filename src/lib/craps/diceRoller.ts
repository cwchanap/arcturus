/**
 * Dice roller for Craps — simulates two standard six-sided dice
 */

import type { DieFace, DiceRoll } from './types';

export function rollDie(): DieFace {
	return (Math.floor(Math.random() * 6) + 1) as DieFace;
}

export function rollDice(): DiceRoll {
	const die1 = rollDie();
	const die2 = rollDie();
	return {
		die1,
		die2,
		total: die1 + die2,
		isHard: die1 === die2,
	};
}

/** Create a specific roll for testing */
export function createRoll(die1: DieFace, die2: DieFace): DiceRoll {
	return { die1, die2, total: die1 + die2, isHard: die1 === die2 };
}

/** Number of combinations that produce a given total (out of 36) */
export function rollCombinations(total: number): number {
	const combos: Record<number, number> = {
		2: 1,
		3: 2,
		4: 3,
		5: 4,
		6: 5,
		7: 6,
		8: 5,
		9: 4,
		10: 3,
		11: 2,
		12: 1,
	};
	return combos[total] ?? 0;
}
