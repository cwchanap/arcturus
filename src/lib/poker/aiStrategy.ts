/**
 * AI strategy for poker opponents.
 * Local non-LLM decision making with difficulty and personality tuning.
 */

import type { AIDecision, AIPersonality, GameContext, Player } from './types';
import {
	DEFAULT_AI_DIFFICULTY,
	applyPersonalityToDifficulty,
	getDifficultyProfile,
	type AIDifficulty,
} from './aiDifficulty';
import { chooseRaiseAmount } from './aiBetSizing';
import { estimateVisibleEquity } from './aiEquity';
import { clamp } from './aiMath';

export interface AIConfig {
	personality: AIPersonality;
	difficulty: AIDifficulty;
	random?: () => number;
}

export function createAIConfig(
	personality: AIPersonality,
	difficulty: AIDifficulty = DEFAULT_AI_DIFFICULTY,
): AIConfig {
	return {
		personality,
		difficulty,
	};
}

export function makeAIDecision(context: GameContext, config: AIConfig): AIDecision {
	const random = config.random ?? Math.random;
	const profile = applyPersonalityToDifficulty(
		getDifficultyProfile(config.difficulty),
		config.personality,
	);
	const equityEstimate = estimateVisibleEquity(context);
	const texture = {
		pressure: equityEstimate.texturePressure,
		kind: equityEstimate.textureKind,
	};
	const highestBet = Math.max(...context.players.map((player) => player.currentBet), 0);
	const callAmount = Math.max(0, highestBet - context.player.currentBet);
	const canCheck = callAmount === 0;
	const position = context.position ?? getPosition(context.player, context.players);
	const positionRaiseAdjustment = position === 'late' ? -0.03 : position === 'early' ? 0.03 : 0;
	const pressureAdjustment = equityEstimate.potOdds > 0.35 ? 0.04 : 0;
	const continueThreshold = clamp(
		profile.continueThreshold +
			pressureAdjustment +
			texture.pressure * 0.06 * profile.textureSensitivity,
		0.12,
		0.9,
	);
	const raiseThreshold = clamp(profile.raiseThreshold + positionRaiseAdjustment, 0.3, 0.92);
	const mistakeOffset = random() < profile.mistakeRate ? (random() < 0.5 ? -0.1 : 0.1) : 0;
	const effectiveEquity = clamp(equityEstimate.equity + mistakeOffset, 0, 1);
	// Two-pair (0.6) and above count as a value made hand. Below that
	// (single pair / high card) the hand is only raised via equity threshold
	// or as a semi-bluff.
	const valueMadeHand = equityEstimate.madeStrength >= 0.6;
	const drawPressureTarget = canCheck ? 0.12 : equityEstimate.potOdds * 0.75;
	const drawIsRelevant =
		equityEstimate.drawPotential * profile.drawSensitivity > drawPressureTarget;
	const shouldSemiBluff =
		drawIsRelevant && equityEstimate.drawPotential >= 0.14 && random() < profile.semiBluffFrequency;
	const shouldPureBluff =
		canCheck &&
		position === 'late' &&
		effectiveEquity < raiseThreshold &&
		random() < profile.bluffFrequency;
	const reasonBase = `${config.difficulty} equity=${equityEstimate.equity.toFixed(2)} potOdds=${equityEstimate.potOdds.toFixed(2)} texture=${texture.kind}`;

	if (canCheck) {
		if (valueMadeHand || effectiveEquity >= raiseThreshold || shouldSemiBluff || shouldPureBluff) {
			const amount = chooseRaiseAmount({
				context,
				profile,
				equity: Math.max(effectiveEquity, equityEstimate.madeStrength),
				texturePressure: texture.pressure,
			});

			if (amount != null) {
				return {
					action: 'raise',
					amount,
					confidence: effectiveEquity,
					reasoning: `${reasonBase} ${
						shouldSemiBluff ? 'semi-bluff' : shouldPureBluff ? 'bluff' : 'value-raise'
					}`,
				};
			}
		}

		return {
			action: 'check',
			confidence: effectiveEquity,
			reasoning: `${reasonBase} check`,
		};
	}

	if (valueMadeHand || effectiveEquity >= raiseThreshold || shouldSemiBluff) {
		const amount = chooseRaiseAmount({
			context,
			profile,
			equity: Math.max(effectiveEquity, equityEstimate.madeStrength),
			texturePressure: texture.pressure,
		});

		if (amount != null) {
			return {
				action: 'raise',
				amount,
				confidence: effectiveEquity,
				reasoning: `${reasonBase} ${shouldSemiBluff ? 'semi-bluff' : 'value-raise'}`,
			};
		}
	}

	if (
		callAmount > 0 &&
		(effectiveEquity >= continueThreshold ||
			equityEstimate.potOdds < 0.22 * profile.callLooseness ||
			drawIsRelevant)
	) {
		return {
			action: 'call',
			confidence: effectiveEquity,
			reasoning: `${reasonBase} continue`,
		};
	}

	return {
		action: 'fold',
		confidence: effectiveEquity,
		reasoning: `${reasonBase} fold`,
	};
}

function getPosition(player: Player, players: Player[]): 'early' | 'middle' | 'late' {
	const dealerIndex = players.findIndex((p) => p.isDealer);
	const playerIndex = players.findIndex((p) => p.id === player.id);

	// No dealer assigned — return a neutral middle position rather than
	// letting the shifted modulo math silently assign an arbitrary seat.
	if (dealerIndex === -1 || playerIndex === -1) return 'middle';

	const positionFromDealer = (playerIndex - dealerIndex + players.length) % players.length;

	if (positionFromDealer === 0) return 'late';
	// 3-handed: dealer=late, the seat immediately after the dealer acts first
	// postflop (early), and the remaining seat is middle. Without this special
	// case both non-dealer seats collapse to 'early' and 'middle' is unreachable.
	// Mirrors PokerGame.getPlayerPosition so the fallback stays consistent.
	if (players.length === 3) {
		return positionFromDealer === 1 ? 'early' : 'middle';
	}
	if (positionFromDealer <= 2) return 'early';
	if (positionFromDealer === 3) return 'middle';
	return 'late';
}
