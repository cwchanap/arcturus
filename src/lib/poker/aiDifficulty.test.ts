import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_AI_DIFFICULTY,
	applyPersonalityToDifficulty,
	getDifficultyProfile,
	type AIDifficulty,
} from './aiDifficulty';

describe('aiDifficulty', () => {
	test('defaults to medium difficulty', () => {
		expect(DEFAULT_AI_DIFFICULTY).toBe('medium');
		expect(getDifficultyProfile().difficulty).toBe('medium');
	});

	test('exposes easy, medium, and hard profiles with increasing sophistication', () => {
		const easy = getDifficultyProfile('easy');
		const medium = getDifficultyProfile('medium');
		const hard = getDifficultyProfile('hard');

		expect(easy.mistakeRate).toBeGreaterThan(medium.mistakeRate);
		expect(medium.mistakeRate).toBeGreaterThan(hard.mistakeRate);
		expect(easy.textureSensitivity).toBeLessThan(medium.textureSensitivity);
		expect(medium.textureSensitivity).toBeLessThan(hard.textureSensitivity);
		expect(easy.drawSensitivity).toBeLessThan(medium.drawSensitivity);
		expect(medium.drawSensitivity).toBeLessThan(hard.drawSensitivity);
	});

	test('returns a copy so callers cannot mutate base profiles', () => {
		const profile = getDifficultyProfile('hard');
		profile.mistakeRate = 0.99;

		expect(getDifficultyProfile('hard').mistakeRate).not.toBe(0.99);
	});

	test('tight personality narrows continuing range', () => {
		const base = getDifficultyProfile('medium');
		const adjusted = applyPersonalityToDifficulty(base, 'tight-aggressive');

		expect(adjusted.continueThreshold).toBeGreaterThan(base.continueThreshold);
		expect(adjusted.bluffFrequency).toBeLessThanOrEqual(base.bluffFrequency);
	});

	test('loose personality widens continuing range', () => {
		const base = getDifficultyProfile('medium');
		const adjusted = applyPersonalityToDifficulty(base, 'loose-passive');

		expect(adjusted.continueThreshold).toBeLessThan(base.continueThreshold);
	});

	test('aggressive personality raises and bluffs more than passive personality', () => {
		const base = getDifficultyProfile('hard');
		const aggressive = applyPersonalityToDifficulty(base, 'loose-aggressive');
		const passive = applyPersonalityToDifficulty(base, 'loose-passive');

		expect(aggressive.raiseThreshold).toBeLessThan(passive.raiseThreshold);
		expect(aggressive.bluffFrequency).toBeGreaterThan(passive.bluffFrequency);
		expect(aggressive.aggressionMultiplier).toBeGreaterThan(passive.aggressionMultiplier);
	});

	test('rejects unknown difficulty at compile-time through AIDifficulty union', () => {
		const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
		expect(difficulties.map((difficulty) => getDifficultyProfile(difficulty).difficulty)).toEqual(
			difficulties,
		);
	});
});
