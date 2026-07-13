import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GameSettingsManager } from './GameSettingsManager';
import { DEFAULT_SETTINGS } from './constants';
import type { RouletteSettings } from './types';

const STORAGE_KEY = 'roulette-settings';

class MemoryStorage implements Storage {
	private store = new Map<string, string>();
	public getItemShouldThrow = false;
	public setItemShouldThrow = false;
	get length() {
		return this.store.size;
	}
	clear() {
		this.store.clear();
	}
	getItem(key: string): string | null {
		if (this.getItemShouldThrow) throw new Error('localStorage unavailable');
		return this.store.has(key) ? (this.store.get(key) as string) : null;
	}
	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
	}
	removeItem(key: string) {
		this.store.delete(key);
	}
	setItem(key: string, value: string) {
		if (this.setItemShouldThrow) throw new Error('localStorage full');
		this.store.set(key, String(value));
	}
}

let storage: MemoryStorage;
let originalLocalStorage: Storage | undefined;
let originalWindow: unknown;

beforeEach(() => {
	storage = new MemoryStorage();
	originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
	originalWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { localStorage: Storage }).localStorage = storage;
	// Impl gates persistence on `typeof window !== 'undefined'`; force a browser env
	// for every test so save()/load() actually touch the mock. Capture per-test so a
	// stale module-level capture can't leak another suite's window state in here.
	(globalThis as { window: unknown }).window = {};
});

afterEach(() => {
	if (!originalLocalStorage) {
		delete (globalThis as { localStorage?: Storage }).localStorage;
	} else {
		(globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
	}
	if (typeof originalWindow === 'undefined') {
		delete (globalThis as { window?: unknown }).window;
	} else {
		(globalThis as { window: unknown }).window = originalWindow;
	}
});

describe('Roulette GameSettingsManager', () => {
	describe('constructor & initialization', () => {
		test('initializes with default settings when localStorage is empty', () => {
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});

		test('loads settings from localStorage when available', () => {
			const custom: RouletteSettings = { animationSpeed: 'fast', soundEnabled: false };
			storage.setItem(STORAGE_KEY, JSON.stringify(custom));

			const manager = new GameSettingsManager();
			const settings = manager.getSettings();
			expect(settings.animationSpeed).toBe('fast');
			expect(settings.soundEnabled).toBe(false);
		});

		test('merges partial settings with defaults for missing fields', () => {
			storage.setItem(STORAGE_KEY, JSON.stringify({ animationSpeed: 'slow' }));

			const manager = new GameSettingsManager();
			const settings = manager.getSettings();
			expect(settings.animationSpeed).toBe('slow');
			expect(settings.soundEnabled).toBe(DEFAULT_SETTINGS.soundEnabled);
		});

		test('handles corrupted (non-JSON) localStorage data', () => {
			storage.setItem(STORAGE_KEY, 'not-json');
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});

		test('handles non-object JSON payload', () => {
			storage.setItem(STORAGE_KEY, JSON.stringify(42));
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});

		test('handles localStorage.getItem throwing error', () => {
			storage.getItemShouldThrow = true;
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});

		test('returns defaults when window is undefined (SSR)', () => {
			delete (globalThis as { window?: unknown }).window;
			storage.setItem(STORAGE_KEY, JSON.stringify({ animationSpeed: 'fast' }));
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
			// localStorage must not have been touched in SSR
			expect(storage.length).toBe(1);
		});
	});

	describe('getSettings', () => {
		test('returns a copy, not the internal reference', () => {
			const manager = new GameSettingsManager();
			const a = manager.getSettings();
			const b = manager.getSettings();
			expect(a).toEqual(b);
			expect(a).not.toBe(b);
		});

		test('modifying the returned object does not affect internal state', () => {
			const manager = new GameSettingsManager();
			const settings = manager.getSettings();
			settings.animationSpeed = 'fast';
			settings.soundEnabled = false;

			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});
	});

	describe('updateSettings', () => {
		test('updates a single setting and persists to localStorage', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'fast' });

			expect(manager.getSettings().animationSpeed).toBe('fast');
			const saved = JSON.parse(storage.getItem(STORAGE_KEY) as string);
			expect(saved.animationSpeed).toBe('fast');
		});

		test('updates multiple settings at once', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'slow', soundEnabled: false });

			const settings = manager.getSettings();
			expect(settings.animationSpeed).toBe('slow');
			expect(settings.soundEnabled).toBe(false);
		});

		test('keeps in-memory state when localStorage.setItem throws', () => {
			storage.setItemShouldThrow = true;
			const manager = new GameSettingsManager();
			const result = manager.updateSettings({ animationSpeed: 'fast' });

			expect(result.animationSpeed).toBe('fast');
			expect(manager.getSettings().animationSpeed).toBe('fast');
		});

		test('still applies in-memory update when window is undefined (SSR)', () => {
			delete (globalThis as { window?: unknown }).window;
			const manager = new GameSettingsManager();
			const result = manager.updateSettings({ soundEnabled: false });

			expect(result.soundEnabled).toBe(false);
			expect(manager.getSettings().soundEnabled).toBe(false);
			// save() must be a no-op in SSR: storage keeps its prior contents only
			expect(storage.length).toBe(0);
		});

		test('rejects invalid animationSpeed and keeps default', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'turbo' as RouletteSettings['animationSpeed'] });
			expect(manager.getSettings().animationSpeed).toBe(DEFAULT_SETTINGS.animationSpeed);
		});
	});

	describe('resetToDefaults', () => {
		test('resets all overrides back to defaults and persists', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'fast', soundEnabled: false });

			manager.resetToDefaults();

			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
			const saved = JSON.parse(storage.getItem(STORAGE_KEY) as string);
			expect(saved).toEqual(DEFAULT_SETTINGS);
		});

		test('still reports defaults when localStorage.setItem throws', () => {
			storage.setItemShouldThrow = true;
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'fast' });

			expect(manager.resetToDefaults()).toEqual(DEFAULT_SETTINGS);
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});
	});

	describe('persistence across instances', () => {
		test('settings survive a new manager instance', () => {
			const m1 = new GameSettingsManager();
			m1.updateSettings({ animationSpeed: 'slow', soundEnabled: false });

			const m2 = new GameSettingsManager();
			const settings = m2.getSettings();
			expect(settings.animationSpeed).toBe('slow');
			expect(settings.soundEnabled).toBe(false);
		});
	});

	describe('validation', () => {
		test('accepts animationSpeed "slow"', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'slow' });
			expect(manager.getSettings().animationSpeed).toBe('slow');
		});

		test('accepts animationSpeed "fast"', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'fast' });
			expect(manager.getSettings().animationSpeed).toBe('fast');
		});

		test('accepts animationSpeed "normal" after switching away', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ animationSpeed: 'fast' });
			expect(manager.getSettings().animationSpeed).toBe('fast');

			manager.updateSettings({ animationSpeed: 'normal' });
			expect(manager.getSettings().animationSpeed).toBe('normal');
		});

		test('rejects non-boolean soundEnabled and keeps default', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ soundEnabled: 'yes' as unknown as boolean });
			expect(manager.getSettings().soundEnabled).toBe(DEFAULT_SETTINGS.soundEnabled);
		});

		test('accepts boolean soundEnabled values', () => {
			const manager = new GameSettingsManager();
			manager.updateSettings({ soundEnabled: false });
			expect(manager.getSettings().soundEnabled).toBe(false);

			manager.updateSettings({ soundEnabled: true });
			expect(manager.getSettings().soundEnabled).toBe(true);
		});

		test('sanitizes invalid values loaded from localStorage', () => {
			storage.setItem(
				STORAGE_KEY,
				JSON.stringify({ animationSpeed: 'turbo', soundEnabled: 'loud' }),
			);
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});

		test('drops null-valued fields from localStorage and uses defaults', () => {
			storage.setItem(STORAGE_KEY, JSON.stringify({ animationSpeed: null, soundEnabled: null }));
			const manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});
	});
});
