// src/lib/keno/GameSettingsManager.test.ts
import { describe, expect, test } from 'bun:test';
import { ANIMATION_DELAY_MS, DEFAULT_SETTINGS } from './constants';
import { GameSettingsManager } from './GameSettingsManager';

function makeStore() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
	};
}

describe('GameSettingsManager', () => {
	test('loads defaults when no storage', () => {
		const s = new GameSettingsManager('u_abc', makeStore());
		expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
	});
	test('persists and reloads', () => {
		const store = makeStore();
		const s = new GameSettingsManager('u_abc', store);
		s.setSetting('animationSpeed', 'fast');
		const reloaded = new GameSettingsManager('u_abc', store);
		expect(reloaded.getSetting('animationSpeed')).toBe('fast');
	});
	test('namespaced key per clientUserId', () => {
		const store = makeStore();
		new GameSettingsManager('u_abc', store).setSetting('animationSpeed', 'fast');
		expect(store.getItem('arcturus:keno:settings:u_abc')).toBeTruthy();
		expect(new GameSettingsManager('u_def', store).getSetting('animationSpeed')).toBe('normal');
	});
	test('getAnimationDelay maps speed → ms', () => {
		const s = new GameSettingsManager('u_abc', makeStore());
		expect(s.getAnimationDelay()).toBe(ANIMATION_DELAY_MS.normal);
		s.setSetting('animationSpeed', 'fast');
		expect(s.getAnimationDelay()).toBe(ANIMATION_DELAY_MS.fast);
	});
	test('corrupted JSON falls back to defaults', () => {
		const store = makeStore();
		store.setItem('arcturus:keno:settings:u_abc', '{not json');
		const s = new GameSettingsManager('u_abc', store);
		expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
	});
	test('defaultStore returns null when window is undefined (no DOM)', () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		Reflect.deleteProperty(globalThis, 'window');
		try {
			const s = new GameSettingsManager('u_abc');
			expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
			expect(() => s.setSetting('animationSpeed', 'fast')).not.toThrow();
			expect(s.getSetting('animationSpeed')).toBe('fast');
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		}
	});
});
