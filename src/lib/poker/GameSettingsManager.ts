/**
 * GameSettingsManager - Handles loading, saving, and applying game settings
 */

import type { GameSettings } from './types';
import { isAIDifficulty } from './aiDifficulty';
import { DEFAULT_SETTINGS } from './types';

const SETTINGS_KEY = 'poker_game_settings';

const AI_SPEEDS = new Set<GameSettings['aiSpeed']>(['slow', 'normal', 'fast']);
const AI_PERSONALITIES = new Set<GameSettings['aiPersonality1']>([
	'tight-aggressive',
	'loose-aggressive',
	'tight-passive',
	'loose-passive',
]);

export function isAISpeed(value: unknown): value is GameSettings['aiSpeed'] {
	return typeof value === 'string' && AI_SPEEDS.has(value as GameSettings['aiSpeed']);
}

export function isAIPersonality(value: unknown): value is GameSettings['aiPersonality1'] {
	return typeof value === 'string' && AI_PERSONALITIES.has(value as GameSettings['aiPersonality1']);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Sanitize a partial settings object, dropping any field whose value is not a
 * valid member of its domain. Used at write time so invalid values from a
 * malformed DOM or stale localStorage never persist.
 */
function sanitizePartialSettings(incoming: Partial<GameSettings>): Partial<GameSettings> {
	const sanitized: Partial<GameSettings> = {};

	if (isPositiveInteger(incoming.startingChips)) {
		sanitized.startingChips = incoming.startingChips;
	}
	if (isPositiveInteger(incoming.smallBlind)) {
		sanitized.smallBlind = incoming.smallBlind;
	}
	if (isPositiveInteger(incoming.bigBlind)) {
		sanitized.bigBlind = incoming.bigBlind;
	}
	if (isAISpeed(incoming.aiSpeed)) {
		sanitized.aiSpeed = incoming.aiSpeed;
	}
	if (isAIPersonality(incoming.aiPersonality1)) {
		sanitized.aiPersonality1 = incoming.aiPersonality1;
	}
	if (isAIPersonality(incoming.aiPersonality2)) {
		sanitized.aiPersonality2 = incoming.aiPersonality2;
	}
	if (isAIDifficulty(incoming.aiDifficulty1)) {
		sanitized.aiDifficulty1 = incoming.aiDifficulty1;
	}
	if (isAIDifficulty(incoming.aiDifficulty2)) {
		sanitized.aiDifficulty2 = incoming.aiDifficulty2;
	}
	if (typeof incoming.useLLMAI === 'boolean') {
		sanitized.useLLMAI = incoming.useLLMAI;
	}

	return sanitized;
}

export class GameSettingsManager {
	private settings: GameSettings;

	constructor() {
		this.settings = this.loadSettings();
	}

	/**
	 * Load settings from localStorage or use defaults
	 */
	private loadSettings(): GameSettings {
		try {
			const stored = localStorage.getItem(SETTINGS_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				// Route every field through the same domain validator used at
				// write time so corrupted localStorage (e.g. bigBlind: -5) is
				// dropped before merge rather than surviving into runtime state.
				const sanitized = sanitizePartialSettings(parsed);
				return {
					...DEFAULT_SETTINGS,
					...sanitized,
				};
			}
		} catch (error) {
			console.error('Failed to load settings:', error);
		}
		return { ...DEFAULT_SETTINGS };
	}

	/**
	 * Save current settings to localStorage
	 */
	private saveSettings(): void {
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
		} catch (error) {
			console.error('Failed to save settings:', error);
		}
	}

	/**
	 * Get current settings
	 */
	public getSettings(): GameSettings {
		return { ...this.settings };
	}

	/**
	 * Update settings and save to localStorage. Invalid field values are
	 * dropped (the existing value is retained) so a malformed DOM or stale
	 * storage entry can never persist an out-of-domain setting.
	 */
	public updateSettings(newSettings: Partial<GameSettings>): void {
		const sanitized = sanitizePartialSettings(newSettings);
		this.settings = {
			...this.settings,
			...sanitized,
		};
		this.saveSettings();
	}

	/**
	 * Reset settings to defaults
	 */
	public resetToDefaults(): void {
		this.settings = { ...DEFAULT_SETTINGS };
		this.saveSettings();
	}

	/**
	 * Get AI delay based on speed setting
	 */
	public getAIDelay(): { min: number; max: number } {
		switch (this.settings.aiSpeed) {
			case 'slow':
				return { min: 1500, max: 2500 };
			case 'fast':
				return { min: 300, max: 600 };
			case 'normal':
			default:
				return { min: 800, max: 1500 };
		}
	}
}
