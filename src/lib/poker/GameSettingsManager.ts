/**
 * GameSettingsManager - Handles loading, saving, and applying game settings
 */

import type { GameSettings } from './types';
import { DEFAULT_SETTINGS } from './types';

const SETTINGS_KEY = 'poker_game_settings';

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
				// Filter out null/undefined values to prevent invalid states
				const validSettings: Partial<GameSettings> = {};
				for (const key in parsed) {
					if (parsed[key] != null) {
						// != null checks for both null and undefined
						validSettings[key as keyof GameSettings] = parsed[key];
					}
				}
				// Validate and merge with defaults to ensure all fields exist
				return {
					...DEFAULT_SETTINGS,
					...validSettings,
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
	 * Update settings and save to localStorage
	 */
	public updateSettings(newSettings: Partial<GameSettings>): void {
		this.settings = {
			...this.settings,
			...newSettings,
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
