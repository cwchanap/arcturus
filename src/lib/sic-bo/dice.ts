/**
 * Local dice helpers for Sic Bo
 */

import type { DieFace, SicBoRoll } from './types';

/** Roll a single six-sided die using the injected random source. */
export function rollDie(random: () => number = Math.random): DieFace {
	return (Math.floor(random() * 6) + 1) as DieFace;
}

/** Roll exactly three dice. */
export function rollThreeDice(random: () => number = Math.random): SicBoRoll {
	return [rollDie(random), rollDie(random), rollDie(random)];
}
