import type { GameContext } from './types';
import {
	calculatePotOdds,
	estimateDrawingOuts,
	evaluatePostflopHand,
	evaluatePreflopHand,
} from './handEvaluator';
import { classifyBoardTexture } from './aiBoardTexture';
import { clamp } from './aiMath';

export interface VisibleEquityEstimate {
	equity: number;
	madeStrength: number;
	drawPotential: number;
	potOdds: number;
	callAmount: number;
	outs: number;
	texturePressure: number;
	activeOpponents: number;
}

export function estimateVisibleEquity(context: GameContext): VisibleEquityEstimate {
	const highestBet = Math.max(...context.players.map((player) => player.currentBet), 0);
	const callAmount = Math.max(0, highestBet - context.player.currentBet);
	const potOdds = calculatePotOdds(callAmount, context.pot);
	const madeStrength =
		context.communityCards.length === 0
			? evaluatePreflopHand(context.player.hand[0], context.player.hand[1])
			: evaluatePostflopHand(context.player.hand, context.communityCards);
	const outs = estimateDrawingOuts(context.player.hand, context.communityCards);
	const texture = classifyBoardTexture(context.communityCards);
	const activeOpponents = Math.max(
		0,
		context.players.filter((player) => player.id !== context.player.id && !player.folded).length,
	);

	const streetMultiplier =
		context.bettingRound === 'flop' ? 2 : context.bettingRound === 'turn' ? 1 : 0;
	const drawPotential = clamp(outs * 0.018 * streetMultiplier, 0, 0.34);
	const opponentPenalty = clamp(activeOpponents * 0.045, 0, 0.18);
	const texturePenalty = context.communityCards.length === 0 ? 0 : texture.pressure * 0.12;
	const pairedHighCardPenalty =
		texture.paired && texture.highCardCount >= 2 && madeStrength < 0.55 ? 0.4 : 0;
	const positionBonus =
		context.position === 'late' ? 0.03 : context.position === 'early' ? -0.025 : 0;

	const equity = clamp(
		madeStrength +
			drawPotential -
			opponentPenalty -
			texturePenalty -
			pairedHighCardPenalty +
			positionBonus,
		0,
		1,
	);

	return {
		equity,
		madeStrength,
		drawPotential,
		potOdds,
		callAmount,
		outs,
		texturePressure: texture.pressure,
		activeOpponents,
	};
}
