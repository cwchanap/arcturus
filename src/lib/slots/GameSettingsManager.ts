import { DEFAULT_SETTINGS } from './constants';
import type { SlotSettings, SpinSpeed } from './types';

const KEY_PREFIX = 'arcturus:slots:settings:';

export class GameSettingsManager {
	private readonly storageKey: string;
	private settings: SlotSettings;

	constructor(clientUserId: string) {
		this.storageKey = `${KEY_PREFIX}${clientUserId}`;
		this.settings = this.loadSettings();
	}

	getSettings(): SlotSettings {
		return { ...this.settings };
	}

	updateSettings(updates: Partial<SlotSettings>): SlotSettings {
		this.settings = { ...this.settings, ...this.sanitize(updates) };
		this.saveSettings();
		return this.getSettings();
	}

	resetToDefaults(): SlotSettings {
		this.settings = { ...DEFAULT_SETTINGS };
		this.saveSettings();
		return this.getSettings();
	}

	clearStorage(): void {
		if (typeof window === 'undefined') return;
		try {
			localStorage.removeItem(this.storageKey);
		} catch (error) {
			console.error('Failed to clear slots settings:', error);
		}
		this.settings = { ...DEFAULT_SETTINGS };
	}

	private loadSettings(): SlotSettings {
		if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
		try {
			const stored = localStorage.getItem(this.storageKey);
			if (stored) {
				return { ...DEFAULT_SETTINGS, ...this.sanitize(JSON.parse(stored)) };
			}
		} catch (error) {
			console.error('Failed to load slots settings:', error);
		}
		return { ...DEFAULT_SETTINGS };
	}

	private saveSettings(): void {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
		} catch (error) {
			console.error('Failed to save slots settings:', error);
		}
	}

	private sanitize(candidate: Partial<SlotSettings>): Partial<SlotSettings> {
		const safe: Partial<SlotSettings> = {};
		if (
			candidate.spinSpeed === 'slow' ||
			candidate.spinSpeed === 'normal' ||
			candidate.spinSpeed === 'fast'
		) {
			safe.spinSpeed = candidate.spinSpeed as SpinSpeed;
		}
		if (typeof candidate.soundEnabled === 'boolean') safe.soundEnabled = candidate.soundEnabled;
		if (typeof candidate.quickSpin === 'boolean') safe.quickSpin = candidate.quickSpin;
		return safe;
	}
}
