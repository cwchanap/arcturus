import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	SOUND_MUTED_STORAGE_KEY,
	bindSoundToggle,
	isSoundMuted,
	setSoundMuted,
} from './sound-preference';

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

/** Reads fine but can no longer persist (e.g. quota exhausted). */
class QuotaExceededStorage extends MemoryStorage {
	constructor(seedKey: string, seedValue: string) {
		super();
		super.setItem(seedKey, seedValue);
	}
	setItem(): never {
		throw new Error('QuotaExceededError');
	}
}

/** Minimal toggle-button double carrying attributes and click handlers. */
function fakeToggle(labels = { on: 'Sound on', off: 'Sound off' }) {
	const attrs = new Map<string, string>([
		['data-sound-label-on', labels.on],
		['data-sound-label-off', labels.off],
	]);
	const clickHandlers: Array<() => void> = [];
	return {
		attrs,
		click() {
			for (const handler of clickHandlers) handler();
		},
		addEventListener: (event: string, handler: () => void) => {
			if (event === 'click') clickHandlers.push(handler);
		},
		getAttribute: (name: string) => attrs.get(name) ?? null,
		setAttribute: (name: string, value: string) => void attrs.set(name, value),
	} as unknown as HTMLElement & { attrs: Map<string, string> };
}

const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

describe('sound preference', () => {
	beforeEach(() => {
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage =
			new MemoryStorage();
		// Reset both layers: module memory first, then drop the stored key.
		setSoundMuted(false);
		localStorage.removeItem(SOUND_MUTED_STORAGE_KEY);
	});

	afterEach(() => {
		(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
	});

	test('defaults to unmuted', () => {
		expect(isSoundMuted()).toBe(false);
	});

	test('writes the choice through to storage', () => {
		setSoundMuted(true);
		expect(isSoundMuted()).toBe(true);
		expect(localStorage.getItem(SOUND_MUTED_STORAGE_KEY)).toBe('true');

		setSoundMuted(false);
		expect(isSoundMuted()).toBe(false);
		expect(localStorage.getItem(SOUND_MUTED_STORAGE_KEY)).toBe('false');
	});

	test('keeps the choice in memory when localStorage is unavailable', () => {
		(globalThis as { localStorage?: Storage }).localStorage = undefined;
		setSoundMuted(true);
		expect(isSoundMuted()).toBe(true);
	});

	test('keeps bound toggles on the same page in sync', () => {
		const header = fakeToggle();
		const game = fakeToggle({ on: '効果音オン', off: '効果音オフ' });
		bindSoundToggle(header);
		bindSoundToggle(game);
		expect(header.attrs.get('aria-pressed')).toBe('true');

		header.click();
		expect(header.attrs.get('aria-pressed')).toBe('false');
		expect(game.attrs.get('aria-pressed')).toBe('false');
		expect(header.attrs.get('aria-label')).toBe('Sound off');
		expect(game.attrs.get('aria-label')).toBe('効果音オフ');

		game.click();
		expect(header.attrs.get('aria-pressed')).toBe('true');
		expect(game.attrs.get('aria-pressed')).toBe('true');
		expect(game.attrs.get('aria-label')).toBe('効果音オン');
	});

	test('reports each toggle through onToggle', () => {
		const seen: boolean[] = [];
		const button = fakeToggle();
		bindSoundToggle(button, (muted) => seen.push(muted));
		button.click();
		button.click();
		expect(seen).toEqual([true, false]);
	});

	test('ignores a missing button', () => {
		expect(() => bindSoundToggle(null)).not.toThrow();
	});

	// Kept last: treating storage as unavailable after a failed write is
	// sticky for the rest of the module's lifetime.
	test('keeps the choice in memory after a failed write (quota exhausted)', () => {
		// Storage still holds the stale unmuted value and reads fine, but can
		// no longer persist (quota exhausted): the stale value must not win.
		(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage =
			new QuotaExceededStorage(SOUND_MUTED_STORAGE_KEY, 'false');
		setSoundMuted(true);
		expect(isSoundMuted()).toBe(true);
		setSoundMuted(false);
		expect(isSoundMuted()).toBe(false);
	});
});
