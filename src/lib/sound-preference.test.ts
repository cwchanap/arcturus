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

	test('caches a successful read as the fallback for later read failures', () => {
		localStorage.setItem(SOUND_MUTED_STORAGE_KEY, 'true');
		expect(isSoundMuted()).toBe(true);
		// Reads then start failing (partitioned/evicted storage): the last
		// successful read must answer, not the unmuted default — muted stays
		// muted instead of silently permitting audio.
		(globalThis as { localStorage?: Storage }).localStorage = {
			getItem: () => {
				throw new Error('storage read denied');
			},
			setItem: () => {},
			removeItem: () => {},
		} as unknown as Storage;
		expect(isSoundMuted()).toBe(true);
	});

	test('a successful read with no saved preference restores the unmuted default', () => {
		setSoundMuted(true);
		localStorage.removeItem(SOUND_MUTED_STORAGE_KEY);
		// Storage read fine and held nothing: a fresh page answers unmuted, so
		// this page must too — the stale muted memory must not outlive the key.
		expect(isSoundMuted()).toBe(false);
		// The cache is the last successful read, so later read failures fall
		// back to the unmuted default rather than the cleared muted value.
		(globalThis as { localStorage?: Storage }).localStorage = {
			getItem: () => {
				throw new Error('storage read denied');
			},
			setItem: () => {},
			removeItem: () => {},
		} as unknown as Storage;
		expect(isSoundMuted()).toBe(false);
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

	test('marks a bound button once its saved state is rendered', () => {
		const button = fakeToggle();
		bindSoundToggle(button);
		expect(button.attrs.get('data-sound-bound')).toBe('true');
	});

	test('re-renders bound toggles when another tab changes the preference', async () => {
		// The module binds `storage` at import time, so capture the handler in
		// a private instance like the sticky-flag tests above.
		const handlers: Array<(event: { key: string | null }) => void> = [];
		const originalWindow = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = {
			addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
				if (type === 'storage') handlers.push(handler);
			},
		};
		try {
			const isolated = (await import(
				'./sound-preference?storage-event' as string
			)) as typeof import('./sound-preference');
			const button = fakeToggle();
			isolated.bindSoundToggle(button);
			expect(button.attrs.get('aria-pressed')).toBe('true');

			localStorage.setItem(SOUND_MUTED_STORAGE_KEY, 'true');
			for (const handler of handlers) handler({ key: SOUND_MUTED_STORAGE_KEY });
			expect(button.attrs.get('aria-pressed')).toBe('false');

			// Unrelated keys must not disturb the current render.
			localStorage.setItem(SOUND_MUTED_STORAGE_KEY, 'false');
			for (const handler of handlers) handler({ key: 'unrelated_key' });
			expect(button.attrs.get('aria-pressed')).toBe('false');
		} finally {
			(globalThis as { window?: unknown }).window = originalWindow;
		}
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

	test('a silently non-persisting store keeps the in-page choice in memory', async () => {
		// Reads and writes both "work" but nothing sticks — a dead store that
		// never throws. The write read-back marks it unusable so memory keeps
		// answering instead of an eternally absent key reading as unmuted.
		(globalThis as { localStorage?: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		} as unknown as Storage;
		// Private module instance: the unavailable flag is sticky for life.
		const isolated = (await import(
			'./sound-preference?noop-store' as string
		)) as typeof import('./sound-preference');
		isolated.setSoundMuted(true);
		expect(isolated.isSoundMuted()).toBe(true);
		isolated.setSoundMuted(false);
		expect(isolated.isSoundMuted()).toBe(false);
	});

	test('keeps the choice in memory after a failed write (quota exhausted)', async () => {
		// Storage still holds the stale unmuted value and reads fine, but can
		// no longer persist (quota exhausted): the stale value must not win.
		(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage =
			new QuotaExceededStorage(SOUND_MUTED_STORAGE_KEY, 'false');
		// Bun shares one module registry across test files, and treating
		// storage as unavailable after a failed write is sticky for the
		// module's lifetime — so this test trips the flag in a private module
		// instance instead of polluting every suite that runs afterwards.
		const isolated = (await import(
			'./sound-preference?quota' as string
		)) as typeof import('./sound-preference');
		isolated.setSoundMuted(true);
		expect(isolated.isSoundMuted()).toBe(true);
		isolated.setSoundMuted(false);
		expect(isolated.isSoundMuted()).toBe(false);
	});
});
