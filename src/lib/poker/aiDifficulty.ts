import type { AIPersonality } from './aiStrategy';

export type AIDifficulty = 'easy' | 'medium' | 'hard';

export interface AIDifficultyProfile {
	difficulty: AIDifficulty;
	continueThreshold: number;
	raiseThreshold: number;
	bluffFrequency: number;
	semiBluffFrequency: number;
	mistakeRate: number;
	aggressionMultiplier: number;
	callLooseness: number;
	textureSensitivity: number;
	drawSensitivity: number;
	maxPotRaiseFraction: number;
	minRaiseMultiplier: number;
	maxRaiseMultiplier: number;
}

export const DEFAULT_AI_DIFFICULTY: AIDifficulty = 'medium';

const BASE_PROFILES: Record<AIDifficulty, AIDifficultyProfile> = {
	easy: {
		difficulty: 'easy',
		continueThreshold: 0.48,
		raiseThreshold: 0.74,
		bluffFrequency: 0.03,
		semiBluffFrequency: 0.04,
		mistakeRate: 0.18,
		aggressionMultiplier: 0.8,
		callLooseness: 0.85,
		textureSensitivity: 0.25,
		drawSensitivity: 0.35,
		maxPotRaiseFraction: 0.45,
		minRaiseMultiplier: 2,
		maxRaiseMultiplier: 3,
	},
	medium: {
		difficulty: 'medium',
		continueThreshold: 0.4,
		raiseThreshold: 0.66,
		bluffFrequency: 0.08,
		semiBluffFrequency: 0.1,
		mistakeRate: 0.1,
		aggressionMultiplier: 1,
		callLooseness: 1,
		textureSensitivity: 0.55,
		drawSensitivity: 0.65,
		maxPotRaiseFraction: 0.65,
		minRaiseMultiplier: 2.25,
		maxRaiseMultiplier: 4,
	},
	hard: {
		difficulty: 'hard',
		continueThreshold: 0.34,
		raiseThreshold: 0.6,
		bluffFrequency: 0.12,
		semiBluffFrequency: 0.18,
		mistakeRate: 0.05,
		aggressionMultiplier: 1.15,
		callLooseness: 1.08,
		textureSensitivity: 0.85,
		drawSensitivity: 0.9,
		maxPotRaiseFraction: 0.8,
		minRaiseMultiplier: 2.5,
		maxRaiseMultiplier: 5,
	},
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function isAIDifficulty(value: unknown): value is AIDifficulty {
	return value === 'easy' || value === 'medium' || value === 'hard';
}

export function getDifficultyProfile(
	difficulty: AIDifficulty = DEFAULT_AI_DIFFICULTY,
): AIDifficultyProfile {
	const safeDifficulty = isAIDifficulty(difficulty) ? difficulty : DEFAULT_AI_DIFFICULTY;
	return { ...BASE_PROFILES[safeDifficulty] };
}

export function applyPersonalityToDifficulty(
	profile: AIDifficultyProfile,
	personality: AIPersonality,
): AIDifficultyProfile {
	const adjusted = { ...profile };

	if (personality.startsWith('tight')) {
		adjusted.continueThreshold += 0.05;
		adjusted.raiseThreshold += 0.03;
		adjusted.bluffFrequency *= 0.75;
		adjusted.callLooseness *= 0.9;
	}

	if (personality.startsWith('loose')) {
		adjusted.continueThreshold -= 0.05;
		adjusted.raiseThreshold -= 0.02;
		adjusted.callLooseness *= 1.12;
	}

	if (personality.endsWith('aggressive')) {
		adjusted.raiseThreshold -= 0.06;
		adjusted.bluffFrequency *= 1.45;
		adjusted.semiBluffFrequency *= 1.35;
		adjusted.aggressionMultiplier *= 1.2;
		adjusted.maxPotRaiseFraction += 0.08;
	}

	if (personality.endsWith('passive')) {
		adjusted.raiseThreshold += 0.08;
		adjusted.bluffFrequency *= 0.45;
		adjusted.semiBluffFrequency *= 0.55;
		adjusted.aggressionMultiplier *= 0.75;
		adjusted.maxPotRaiseFraction -= 0.12;
	}

	if (personality.startsWith('tight')) {
		adjusted.bluffFrequency = Math.min(adjusted.bluffFrequency, profile.bluffFrequency);
	}

	adjusted.continueThreshold = clamp(adjusted.continueThreshold, 0.18, 0.72);
	adjusted.raiseThreshold = clamp(adjusted.raiseThreshold, 0.38, 0.9);
	adjusted.bluffFrequency = clamp(adjusted.bluffFrequency, 0, 0.35);
	adjusted.semiBluffFrequency = clamp(adjusted.semiBluffFrequency, 0, 0.4);
	adjusted.maxPotRaiseFraction = clamp(adjusted.maxPotRaiseFraction, 0.25, 0.95);

	return adjusted;
}
