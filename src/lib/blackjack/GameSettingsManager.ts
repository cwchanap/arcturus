/**
 * GameSettingsManager - Handles loading, saving, and applying Blackjack game settings
 */

import type { BlackjackSettings } from './types';
import { DEFAULT_SETTINGS, ABSOLUTE_MAX_BET } from './constants';

const SETTINGS_KEY_PREFIX = 'arcturus:blackjack:settings:';

/**
 * Validates settings values are within acceptable ranges
 * Returns a sanitized settings object with defaults for invalid values
 */
function validateSettings(settings: Partial<BlackjackSettings>): Partial<BlackjackSettings> {
	const validated: Partial<BlackjackSettings> = { ...settings };

	// Validate numeric ranges
	if (
		validated.minBet !== undefined &&
		(typeof validated.minBet !== 'number' || validated.minBet <= 0)
	) {
		validated.minBet = DEFAULT_SETTINGS.minBet;
	}
	if (validated.minBet !== undefined && Number.isFinite(validated.minBet)) {
		validated.minBet = Math.trunc(validated.minBet);
	}
	if (
		validated.maxBet !== undefined &&
		(typeof validated.maxBet !== 'number' || validated.maxBet <= 0)
	) {
		validated.maxBet = DEFAULT_SETTINGS.maxBet;
	}
	if (validated.maxBet !== undefined && Number.isFinite(validated.maxBet)) {
		validated.maxBet = Math.trunc(validated.maxBet);
	}
	// Enforce absolute max bet cap (aligns with server API payout limits)
	if (validated.maxBet !== undefined && validated.maxBet > ABSOLUTE_MAX_BET) {
		validated.maxBet = ABSOLUTE_MAX_BET;
	}
	if (
		validated.startingChips !== undefined &&
		(typeof validated.startingChips !== 'number' || validated.startingChips < 0)
	) {
		validated.startingChips = DEFAULT_SETTINGS.startingChips;
	}
	if (validated.startingChips !== undefined && Number.isFinite(validated.startingChips)) {
		validated.startingChips = Math.trunc(validated.startingChips);
	}

	// Ensure minBet <= maxBet
	const minBet = validated.minBet ?? DEFAULT_SETTINGS.minBet;
	const maxBet = validated.maxBet ?? DEFAULT_SETTINGS.maxBet;
	if (minBet > maxBet) {
		validated.minBet = DEFAULT_SETTINGS.minBet;
		validated.maxBet = DEFAULT_SETTINGS.maxBet;
	}

	// Validate dealerSpeed enum
	if (
		validated.dealerSpeed !== undefined &&
		!['slow', 'normal', 'fast'].includes(validated.dealerSpeed)
	) {
		validated.dealerSpeed = DEFAULT_SETTINGS.dealerSpeed;
	}

	// Validate boolean
	if (validated.useLLM !== undefined && typeof validated.useLLM !== 'boolean') {
		validated.useLLM = DEFAULT_SETTINGS.useLLM;
	}

	return validated;
}

export class GameSettingsManager {
	private settings: BlackjackSettings;
	private readonly storageKey: string;

	constructor(userId: string) {
		this.storageKey = `${SETTINGS_KEY_PREFIX}${userId}`;
		this.settings = this.loadSettings();
	}

	/**
	 * Load settings from localStorage or use defaults
	 * Validates all loaded values are within acceptable ranges
	 */
	private loadSettings(): BlackjackSettings {
		try {
			const stored = localStorage.getItem(this.storageKey);
			if (stored) {
				const parsed = JSON.parse(stored) as Partial<BlackjackSettings>;
				const validSettings: Partial<BlackjackSettings> = {};

				for (const key in parsed) {
					const value = parsed[key as keyof BlackjackSettings];
					if (value != null) {
						validSettings[key as keyof BlackjackSettings] = value;
					}
				}

				// Validate values are within acceptable ranges
				const validated = validateSettings(validSettings);

				return {
					...DEFAULT_SETTINGS,
					...validated,
				};
			}
		} catch (error) {
			console.error('Failed to load blackjack settings:', error);
		}

		return { ...DEFAULT_SETTINGS };
	}

	/**
	 * Save current settings to localStorage
	 */
	private saveSettings(): void {
		try {
			localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
		} catch (error) {
			console.error('Failed to save blackjack settings:', error);
		}
	}

	/**
	 * Get current settings (defensive copy)
	 */
	public getSettings(): BlackjackSettings {
		return { ...this.settings };
	}

	/**
	 * Update settings and persist them
	 * Validates all updates before applying
	 */
	public updateSettings(newSettings: Partial<BlackjackSettings>): void {
		// Validate updates before merging
		const validated = validateSettings(newSettings);
		this.settings = {
			...this.settings,
			...validated,
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
	 * Get dealer animation delay (ms) based on speed setting
	 */
	public getDealerDelay(): number {
		switch (this.settings.dealerSpeed) {
			case 'slow':
				return 1500;
			case 'fast':
				return 500;
			case 'normal':
			default:
				return 1000;
		}
	}
}
