// src/lib/keno/GameSettingsManager.ts
import { ANIMATION_DELAY_MS, DEFAULT_SETTINGS, REVEAL_STAGGER_MS } from './constants';
import type { KenoSettings } from './types';

const KEY_PREFIX = 'arcturus:keno:settings:';

type Store = {
	getItem(k: string): string | null;
	setItem(k: string, v: string): void;
	removeItem(k: string): void;
};

function defaultStore(): Store | null {
	if (typeof window === 'undefined') return null;
	return window.localStorage;
}

export class GameSettingsManager {
	private readonly storageKey: string;
	private readonly store: Store | null;
	private settings: KenoSettings;

	constructor(clientUserId: string, store: Store | null = defaultStore()) {
		this.storageKey = `${KEY_PREFIX}${clientUserId}`;
		this.store = store;
		this.settings = this.load();
	}

	private load(): KenoSettings {
		if (!this.store) return { ...DEFAULT_SETTINGS };
		try {
			const raw = this.store.getItem(this.storageKey);
			if (!raw) return { ...DEFAULT_SETTINGS };
			const parsed = JSON.parse(raw) as Partial<KenoSettings>;
			return {
				animationSpeed:
					parsed.animationSpeed === 'slow' || parsed.animationSpeed === 'fast'
						? parsed.animationSpeed
						: 'normal',
			};
		} catch {
			return { ...DEFAULT_SETTINGS };
		}
	}

	getSettings(): KenoSettings {
		return { ...this.settings };
	}
	getSetting<K extends keyof KenoSettings>(key: K): KenoSettings[K] {
		return this.settings[key];
	}
	setSetting<K extends keyof KenoSettings>(key: K, value: KenoSettings[K]): void {
		this.settings = { ...this.settings, [key]: value };
		this.persist();
	}
	getAnimationDelay(): number {
		return ANIMATION_DELAY_MS[this.settings.animationSpeed];
	}
	getRevealStagger(): number {
		return REVEAL_STAGGER_MS[this.settings.animationSpeed];
	}
	private persist(): void {
		if (!this.store) return;
		try {
			this.store.setItem(this.storageKey, JSON.stringify(this.settings));
		} catch {
			// best effort
		}
	}
}
