import type { GameContext } from './types';
import type { AIDifficultyProfile } from './aiDifficulty';

export interface BetSizingInput {
	context: GameContext;
	profile: AIDifficultyProfile;
	equity: number;
	texturePressure: number;
}

function roundToStep(value: number, step: number): number {
	return Math.max(step, Math.round(value / step) * step);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function chooseRaiseAmount(input: BetSizingInput): number | null {
	const { context, profile, equity, texturePressure } = input;
	const highestBet = Math.max(...context.players.map((player) => player.currentBet), 0);
	const callAmount = Math.max(0, highestBet - context.player.currentBet);
	const affordableRaise = context.player.chips - callAmount;

	if (affordableRaise < context.minimumBet) {
		return null;
	}

	const equityPressure = clamp((equity - profile.raiseThreshold) / 0.35, 0, 1);
	const textureDiscount = clamp(texturePressure * 0.25, 0, 0.2);
	const multiplier =
		profile.minRaiseMultiplier +
		(profile.maxRaiseMultiplier - profile.minRaiseMultiplier) * equityPressure;
	const blindBased = context.minimumBet * multiplier * profile.aggressionMultiplier;
	const potBase = Math.max(context.pot + callAmount, context.minimumBet);
	const potBased = potBase * clamp(profile.maxPotRaiseFraction - textureDiscount, 0.25, 0.95);
	const rawRaise = Math.max(context.minimumBet, Math.min(blindBased, potBased));
	const rounded = roundToStep(rawRaise, context.minimumBet);

	return Math.min(rounded, affordableRaise);
}
