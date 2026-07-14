import type { RouletteSettings } from './types';
import { DEFAULT_SETTINGS } from './constants';

const STORAGE_KEY = 'roulette-settings';

export class GameSettingsManager {
	private settings: RouletteSettings;

	constructor() {
		this.settings = this.load();
	}

	private validate(raw: unknown, baseline: RouletteSettings = DEFAULT_SETTINGS): RouletteSettings {
		const s: RouletteSettings = { ...baseline };
		if (!raw || typeof raw !== 'object') return s;
		const p = raw as Partial<RouletteSettings>;
		if (
			p.animationSpeed === 'slow' ||
			p.animationSpeed === 'fast' ||
			p.animationSpeed === 'normal'
		) {
			s.animationSpeed = p.animationSpeed;
		}
		if (typeof p.soundEnabled === 'boolean') s.soundEnabled = p.soundEnabled;
		return s;
	}

	private load(): RouletteSettings {
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

	getSettings(): RouletteSettings {
		return { ...this.settings };
	}

	updateSettings(updates: Partial<RouletteSettings>): RouletteSettings {
		this.settings = this.validate({ ...this.settings, ...updates }, this.settings);
		this.save();
		return this.getSettings();
	}

	resetToDefaults(): RouletteSettings {
		this.settings = { ...DEFAULT_SETTINGS };
		this.save();
		return this.getSettings();
	}
}
