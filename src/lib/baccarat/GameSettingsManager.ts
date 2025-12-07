/**
 * GameSettingsManager - Manages Baccarat game settings with localStorage persistence
 */

import type { BaccaratSettings } from './types';
import { DEFAULT_SETTINGS } from './constants';

const STORAGE_KEY = 'baccarat-settings';

export class GameSettingsManager {
	private settings: BaccaratSettings;

	constructor() {
		this.settings = this.loadSettings();
	}

	/**
	 * Load settings from localStorage or use defaults
	 */
	private loadSettings(): BaccaratSettings {
		if (typeof window === 'undefined') {
			return { ...DEFAULT_SETTINGS };
		}

		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				// Merge with defaults to handle new settings
				return {
					...DEFAULT_SETTINGS,
					...parsed,
				};
			}
		} catch (error) {
			console.error('Failed to load baccarat settings:', error);
		}

		return { ...DEFAULT_SETTINGS };
	}

	/**
	 * Save settings to localStorage
	 */
	private saveSettings(): void {
		if (typeof window === 'undefined') return;

		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
		} catch (error) {
			console.error('Failed to save baccarat settings:', error);
		}
	}

	/**
	 * Get current settings
	 */
	public getSettings(): BaccaratSettings {
		return { ...this.settings };
	}

	/**
	 * Update settings (partial update)
	 */
	public updateSettings(updates: Partial<BaccaratSettings>): BaccaratSettings {
		// Validate updates
		if (updates.minBet !== undefined && updates.minBet < 1) {
			updates.minBet = 1;
		}
		if (updates.maxBet !== undefined && updates.maxBet < 1) {
			updates.maxBet = 1;
		}
		if (updates.startingChips !== undefined && updates.startingChips < 0) {
			updates.startingChips = 0;
		}

		// Ensure minBet <= maxBet
		const newMinBet = updates.minBet ?? this.settings.minBet;
		const newMaxBet = updates.maxBet ?? this.settings.maxBet;
		if (newMinBet > newMaxBet) {
			updates.minBet = newMaxBet;
		}

		this.settings = {
			...this.settings,
			...updates,
		};

		this.saveSettings();
		return this.getSettings();
	}

	/**
	 * Reset settings to defaults
	 */
	public resetToDefaults(): BaccaratSettings {
		this.settings = { ...DEFAULT_SETTINGS };
		this.saveSettings();
		return this.getSettings();
	}

	/**
	 * Get a specific setting
	 */
	public getSetting<K extends keyof BaccaratSettings>(key: K): BaccaratSettings[K] {
		return this.settings[key];
	}

	/**
	 * Set a specific setting
	 */
	public setSetting<K extends keyof BaccaratSettings>(key: K, value: BaccaratSettings[K]): void {
		this.updateSettings({ [key]: value });
	}

	/**
	 * Get animation delay in milliseconds based on speed setting
	 */
	public getAnimationDelay(): number {
		switch (this.settings.animationSpeed) {
			case 'slow':
				return 1500;
			case 'fast':
				return 500;
			default:
				return 1000;
		}
	}

	/**
	 * Check if LLM is enabled
	 */
	public isLLMEnabled(): boolean {
		return this.settings.llmEnabled;
	}

	/**
	 * Toggle LLM
	 */
	public toggleLLM(): boolean {
		this.settings.llmEnabled = !this.settings.llmEnabled;
		this.saveSettings();
		return this.settings.llmEnabled;
	}

	/**
	 * Check if sound is enabled
	 */
	public isSoundEnabled(): boolean {
		return this.settings.soundEnabled;
	}

	/**
	 * Toggle sound
	 */
	public toggleSound(): boolean {
		this.settings.soundEnabled = !this.settings.soundEnabled;
		this.saveSettings();
		return this.settings.soundEnabled;
	}

	/**
	 * Clear all settings from storage
	 */
	public clearStorage(): void {
		if (typeof window === 'undefined') return;

		try {
			localStorage.removeItem(STORAGE_KEY);
			this.settings = { ...DEFAULT_SETTINGS };
		} catch (error) {
			console.error('Failed to clear baccarat settings:', error);
		}
	}
}
