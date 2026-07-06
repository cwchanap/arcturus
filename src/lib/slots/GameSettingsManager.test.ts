import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GameSettingsManager } from './GameSettingsManager';
import { DEFAULT_SETTINGS } from './constants';

const KEY = 'arcturus:slots:settings:user-1';

class MemoryStorage implements Storage {
	private store = new Map<string, string>();
	get length() {
		return this.store.size;
	}
	clear() {
		this.store.clear();
	}
	getItem(key: string): string | null {
		return this.store.has(key) ? (this.store.get(key) as string) : null;
	}
	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
	}
	removeItem(key: string) {
		this.store.delete(key);
	}
	setItem(key: string, value: string) {
		this.store.set(key, String(value));
	}
}

const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeAll(() => {
	if (!originalLocalStorage) {
		(globalThis as { localStorage: Storage }).localStorage = new MemoryStorage();
	}
	// Impl gates persistence on `typeof window !== 'undefined'`; simulate a browser env.
	if (typeof originalWindow === 'undefined') {
		(globalThis as { window: unknown }).window = {};
	}
});

afterAll(() => {
	if (!originalLocalStorage) {
		delete (globalThis as { localStorage?: Storage }).localStorage;
	}
	if (typeof originalWindow === 'undefined') {
		delete (globalThis as { window?: unknown }).window;
	}
});

afterEach(() => {
	try {
		localStorage.removeItem(KEY);
	} catch (_e) {
		// ignore
	}
});

describe('GameSettingsManager', () => {
	test('returns defaults when nothing is stored', () => {
		const mgr = new GameSettingsManager('user-1');
		expect(mgr.getSettings()).toEqual(DEFAULT_SETTINGS);
	});

	test('persists and reloads settings', () => {
		const mgr = new GameSettingsManager('user-1');
		mgr.updateSettings({ spinSpeed: 'fast', quickSpin: true });
		const mgr2 = new GameSettingsManager('user-1');
		expect(mgr2.getSettings().spinSpeed).toBe('fast');
		expect(mgr2.getSettings().quickSpin).toBe(true);
	});

	test('rejects invalid spinSpeed and falls back to default', () => {
		localStorage.setItem(KEY, JSON.stringify({ spinSpeed: 'turbo' }));
		const mgr = new GameSettingsManager('user-1');
		expect(mgr.getSettings().spinSpeed).toBe('normal');
	});

	test('namespaces per user', () => {
		const a = new GameSettingsManager('user-a');
		a.updateSettings({ spinSpeed: 'slow' });
		const b = new GameSettingsManager('user-b');
		expect(b.getSettings().spinSpeed).toBe('normal');
	});

	test('resetToDefaults clears overrides', () => {
		const mgr = new GameSettingsManager('user-1');
		mgr.updateSettings({ soundEnabled: false });
		mgr.resetToDefaults();
		expect(mgr.getSettings()).toEqual(DEFAULT_SETTINGS);
	});

	test('getSpinDurationMs maps speed to duration', () => {
		const mgr = new GameSettingsManager('user-1');
		mgr.updateSettings({ spinSpeed: 'slow' });
		expect(mgr.getSpinDurationMs()).toBeGreaterThan(0);
	});
});
