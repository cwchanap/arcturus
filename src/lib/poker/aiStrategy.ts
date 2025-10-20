/**
 * AI strategy for poker opponents
 * Rule-based decision making with personality traits
 */

import type { AIDecision, GameContext, Player } from './types';
import {
	evaluatePreflopHand,
	evaluatePostflopHand,
	calculatePotOdds,
	estimateDrawingOuts,
} from './handEvaluator';

export type AIPersonality =
	| 'tight-passive'
	| 'tight-aggressive'
	| 'loose-passive'
	| 'loose-aggressive';

export interface AIConfig {
	personality: AIPersonality;
	bluffFrequency: number; // 0-1 scale
	aggressionLevel: number; // 0-1 scale
}

/**
 * Creates an AI config based on personality
 */
export function createAIConfig(personality: AIPersonality): AIConfig {
	switch (personality) {
		case 'tight-aggressive':
			return {
				personality,
				bluffFrequency: 0.15,
				aggressionLevel: 0.75,
			};
		case 'tight-passive':
			return {
				personality,
				bluffFrequency: 0.05,
				aggressionLevel: 0.25,
			};
		case 'loose-aggressive':
			return {
				personality,
				bluffFrequency: 0.25,
				aggressionLevel: 0.85,
			};
		case 'loose-passive':
			return {
				personality,
				bluffFrequency: 0.1,
				aggressionLevel: 0.35,
			};
	}
}

/**
 * Main AI decision function
 */
export function makeAIDecision(context: GameContext, config: AIConfig): AIDecision {
	const { player, players, communityCards, pot, minimumBet, phase } = context;

	// Calculate hand strength
	const handStrength =
		communityCards.length === 0
			? evaluatePreflopHand(player.hand[0], player.hand[1])
			: evaluatePostflopHand(player.hand, communityCards);

	// Calculate pot odds
	const highestBet = Math.max(...players.map((p) => p.currentBet));
	const callAmount = Math.max(0, highestBet - player.currentBet);
	const potOdds = calculatePotOdds(callAmount, pot);

	// Check if we can check (no bet to call)
	const canCheck = callAmount === 0;

	// Determine position
	const position = getPosition(player, players);

	// Add randomization to prevent predictability
	const randomFactor = 0.9 + Math.random() * 0.2; // 0.9-1.1
	const adjustedStrength = handStrength * randomFactor;

	// Decision thresholds based on personality
	const foldThreshold = getFoldThreshold(config, position);
	const raiseThreshold = getRaiseThreshold(config, position);

	// Bluff check
	const shouldBluff = Math.random() < config.bluffFrequency && position === 'late';

	// Make decision
	if (canCheck) {
		// No bet to call - check or raise
		if (shouldBluff || adjustedStrength >= raiseThreshold) {
			const raiseAmount = calculateRaiseAmount(handStrength, config, minimumBet, pot);
			return {
				action: 'raise',
				amount: raiseAmount,
				confidence: handStrength,
				reasoning: shouldBluff
					? 'Bluffing from good position'
					: `Strong hand (${handStrength.toFixed(2)}) - raising`,
			};
		} else {
			return {
				action: 'check',
				confidence: handStrength,
				reasoning: `Moderate hand (${handStrength.toFixed(2)}) - checking`,
			};
		}
	} else {
		// There's a bet to call
		// Check if we're getting good pot odds for a draw
		const outs = estimateDrawingOuts(player.hand, communityCards);
		const equity = outs > 0 ? outs * 0.02 * (phase === 'turn' ? 1 : 2) : 0; // Rough equity calculation

		// Fold if hand is too weak
		if (adjustedStrength < foldThreshold && equity < potOdds) {
			return {
				action: 'fold',
				confidence: handStrength,
				reasoning: `Weak hand (${handStrength.toFixed(2)}) vs pot odds (${potOdds.toFixed(2)})`,
			};
		}

		// Raise if hand is very strong
		if (adjustedStrength >= raiseThreshold || shouldBluff) {
			const raiseAmount = calculateRaiseAmount(handStrength, config, minimumBet, pot);
			return {
				action: 'raise',
				amount: raiseAmount,
				confidence: handStrength,
				reasoning: shouldBluff
					? 'Bluff-raising'
					: `Very strong hand (${handStrength.toFixed(2)}) - raising`,
			};
		}

		// Call if hand is decent or we have good pot odds
		if (adjustedStrength >= foldThreshold || equity > potOdds || potOdds < 0.25) {
			return {
				action: 'call',
				confidence: handStrength,
				reasoning: `Decent hand (${handStrength.toFixed(2)}) or good pot odds (${potOdds.toFixed(2)})`,
			};
		}

		// Default: fold
		return {
			action: 'fold',
			confidence: handStrength,
			reasoning: `Hand not strong enough to call`,
		};
	}
}

/**
 * Gets fold threshold based on personality and position
 */
function getFoldThreshold(config: AIConfig, position: 'early' | 'middle' | 'late'): number {
	let baseThreshold = 0.35;

	// Adjust for personality
	if (config.personality.startsWith('tight')) {
		baseThreshold = 0.45;
	} else if (config.personality.startsWith('loose')) {
		baseThreshold = 0.3;
	}

	// Adjust for position
	if (position === 'late') {
		baseThreshold -= 0.05;
	} else if (position === 'early') {
		baseThreshold += 0.05;
	}

	return baseThreshold;
}

/**
 * Gets raise threshold based on personality and position
 */
function getRaiseThreshold(config: AIConfig, position: 'early' | 'middle' | 'late'): number {
	let baseThreshold = 0.65;

	// Adjust for aggression
	baseThreshold -= config.aggressionLevel * 0.15;

	// Adjust for position
	if (position === 'late') {
		baseThreshold -= 0.05;
	} else if (position === 'early') {
		baseThreshold += 0.05;
	}

	return baseThreshold;
}

/**
 * Calculates raise amount based on hand strength and pot size
 */
function calculateRaiseAmount(
	handStrength: number,
	config: AIConfig,
	minimumBet: number,
	pot: number,
): number {
	// Base multiplier on aggression
	let multiplier = 2 + config.aggressionLevel * 3; // 2-5x

	// Adjust based on hand strength
	if (handStrength >= 0.85) {
		multiplier *= 1.5; // Bet more with very strong hands
	} else if (handStrength < 0.5) {
		multiplier *= 0.7; // Smaller bluffs
	}

	// Calculate raise amount
	const raiseAmount = Math.max(minimumBet, Math.floor(minimumBet * multiplier));

	// Cap at pot size for realism
	return Math.min(raiseAmount, Math.floor(pot * 0.75));
}

/**
 * Determines player's position relative to dealer
 */
function getPosition(player: Player, players: Player[]): 'early' | 'middle' | 'late' {
	const dealerIndex = players.findIndex((p) => p.isDealer);
	const playerIndex = players.findIndex((p) => p.id === player.id);

	const positionFromDealer = (playerIndex - dealerIndex + players.length) % players.length;

	if (positionFromDealer <= 1) {
		return 'early';
	} else if (positionFromDealer <= 2) {
		return 'middle';
	} else {
		return 'late';
	}
}
