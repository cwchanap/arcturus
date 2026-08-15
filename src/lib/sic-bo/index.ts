/**
 * Sic Bo local module public surface
 */

export { rollDie, rollThreeDice } from './dice';
export {
	SIC_BO_CHIP_DENOMINATIONS,
	TOTAL_ODDS,
	getBetOdds,
	isWinningBet,
	resolveBet,
} from './rules';
export { SicBoGame } from './game';
export type {
	DieFace,
	SicBoBet,
	SicBoBetKey,
	SicBoBetResult,
	SicBoExactTotal,
	SicBoPhase,
	SicBoRoll,
	SicBoRoundResult,
	SicBoState,
} from './types';
