/**
 * GameSettingsManager — Craps settings with localStorage persistence
 */

import type { CrapsSettings } from './types';
import { DEFAULT_SETTINGS } from './constants';

const STORAGE_KEY = 'craps-settings';

export class GameSettingsManager {
	private settings: CrapsSettings;

	constructor() {
		this.settings = this.load();
	}

	private validate(raw: unknown): CrapsSettings {
		const s: CrapsSettings = { ...DEFAULT_SETTINGS };
		if (!raw || typeof raw !== 'object') return s;
		const p = raw as Partial<CrapsSettings>;

		if (typeof p.minBet === 'number' && p.minBet >= 1) s.minBet = p.minBet;
		if (typeof p.maxBet === 'number' && p.maxBet >= 1) s.maxBet = p.maxBet;
		if (s.minBet > s.maxBet) s.minBet = s.maxBet;
		if (typeof p.maxOddsMultiplier === 'number' && p.maxOddsMultiplier >= 1)
			s.maxOddsMultiplier = p.maxOddsMultiplier;
		if (p.animationSpeed === 'slow' || p.animationSpeed === 'normal' || p.animationSpeed === 'fast')
			s.animationSpeed = p.animationSpeed;
		if (typeof p.llmEnabled === 'boolean') s.llmEnabled = p.llmEnabled;
		if (typeof p.soundEnabled === 'boolean') s.soundEnabled = p.soundEnabled;
		return s;
	}

	private load(): CrapsSettings {
		if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) return this.validate(JSON.parse(stored));
		} catch {
			// ignore
		}
		return { ...DEFAULT_SETTINGS };
	}

	private save(): void {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
		} catch {
			// ignore
		}
	}

	public getSettings(): CrapsSettings {
		return { ...this.settings };
	}

	public updateSettings(updates: Partial<CrapsSettings>): CrapsSettings {
		const tempMerged: CrapsSettings = { ...this.settings, ...updates };
		if (tempMerged.minBet > tempMerged.maxBet) {
			tempMerged.maxBet = tempMerged.minBet;
		}
		this.settings = this.validate(tempMerged);
		this.save();
		return this.getSettings();
	}

	public resetToDefaults(): CrapsSettings {
		this.settings = { ...DEFAULT_SETTINGS };
		this.save();
		return this.getSettings();
	}
}
