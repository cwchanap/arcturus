import type { GameContext } from './types';
import type { AIDifficultyProfile } from './aiDifficulty';
import { clamp } from './aiMath';

export interface BetSizingInput {
	context: GameContext;
	profile: AIDifficultyProfile;
	equity: number;
	texturePressure: number;
}

function roundToStep(value: number, step: number): number {
	return Math.max(step, Math.round(value / step) * step);
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

	// Capping to affordableRaise may yield a value below the step size when
	// short-stacked — this is intentional (a player can bet up to their whole
	// stack even if it isn't a clean multiple of the blind).
	return Math.min(rounded, affordableRaise);
}
