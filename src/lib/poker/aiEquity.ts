import type { Card, GameContext } from './types';
import {
	calculatePotOdds,
	estimateDrawingOuts,
	evaluatePostflopHand,
	evaluatePreflopHand,
} from './handEvaluator';
import { classifyBoardTexture } from './aiBoardTexture';

export interface VisibleEquityEstimate {
	equity: number;
	madeStrength: number;
	drawPotential: number;
	potOdds: number;
	callAmount: number;
	outs: number;
	texturePressure: number;
	activeOpponents: number;
	unknownCards: number;
}

const SUITS: Card['suit'][] = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function cardKey(card: Card): string {
	return `${card.rank}:${card.suit}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function buildUnknownDeck(knownCards: Card[]): Card[] {
	const known = new Set(knownCards.map(cardKey));
	const deck: Card[] = [];

	for (const suit of SUITS) {
		for (let i = 0; i < VALUES.length; i++) {
			const card = { value: VALUES[i], suit, rank: i + 2 };
			if (!known.has(cardKey(card))) {
				deck.push(card);
			}
		}
	}

	return deck;
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
	const unknownCards = buildUnknownDeck([...context.player.hand, ...context.communityCards]).length;

	const streetMultiplier =
		context.bettingRound === 'flop' ? 2 : context.bettingRound === 'turn' ? 1 : 0.7;
	const drawPotential = clamp(outs * 0.018 * streetMultiplier, 0, 0.34);
	const opponentPenalty = clamp(activeOpponents * 0.045, 0, 0.18);
	const texturePenalty = context.communityCards.length === 0 ? 0 : texture.pressure * 0.12;
	const pairedHighCardPenalty = texture.paired && texture.highCardCount >= 2 ? 0.4 : 0;
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
		unknownCards,
	};
}
