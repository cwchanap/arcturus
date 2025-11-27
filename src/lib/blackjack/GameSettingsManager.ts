/**
 * GameSettingsManager - Handles loading, saving, and applying Blackjack game settings
 */

import type { BlackjackSettings } from './types';
import { DEFAULT_SETTINGS } from './constants';

const SETTINGS_KEY_PREFIX = 'arcturus:blackjack:settings:';

export class GameSettingsManager {
	private settings: BlackjackSettings;
	private readonly storageKey: string;

	constructor(userId: string) {
		this.storageKey = `${SETTINGS_KEY_PREFIX}${userId}`;
		this.settings = this.loadSettings();
	}

	/**
	 * Load settings from localStorage or use defaults
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

				return {
					...DEFAULT_SETTINGS,
					...validSettings,
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
	 */
	public updateSettings(newSettings: Partial<BlackjackSettings>): void {
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
