import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { GameSettingsManager } from './GameSettingsManager';
import { DEFAULT_SETTINGS } from './constants';
import type { BlackjackSettings } from './types';

const USER_ID = 'test-user';
const STORAGE_KEY = `arcturus:blackjack:settings:${USER_ID}`;

describe('Blackjack GameSettingsManager', () => {
	let manager: GameSettingsManager;
	let mockLocalStorage: {
		store: Record<string, string>;
		getItem: ReturnType<typeof mock>;
		setItem: ReturnType<typeof mock>;
		clear: () => void;
	};
	let originalLocalStorage: Storage;

	const withMockedConsoleError = (testFn: (consoleErrorSpy: ReturnType<typeof mock>) => void) => {
		const consoleErrorSpy = mock(() => {});
		const originalConsoleError = console.error;
		console.error = consoleErrorSpy;

		try {
			testFn(consoleErrorSpy);
		} finally {
			console.error = originalConsoleError;
		}
	};

	beforeEach(() => {
		originalLocalStorage = global.localStorage;

		mockLocalStorage = {
			store: {},
			getItem: mock((key: string) => mockLocalStorage.store[key] || null),
			setItem: mock((key: string, value: string) => {
				mockLocalStorage.store[key] = value;
			}),
			clear: () => {
				mockLocalStorage.store = {};
			},
		};

		global.localStorage = mockLocalStorage as unknown as Storage;
	});

	afterEach(() => {
		mockLocalStorage.clear();
		global.localStorage = originalLocalStorage;
	});

	describe('constructor & initialization', () => {
		test('initializes with default settings when localStorage is empty', () => {
			manager = new GameSettingsManager(USER_ID);
			const settings = manager.getSettings();
			expect(settings).toEqual(DEFAULT_SETTINGS);
		});

		test('loads settings from localStorage when available', () => {
			const custom: BlackjackSettings = {
				...DEFAULT_SETTINGS,
				startingChips: 2000,
				dealerSpeed: 'fast',
				useLLM: true,
			};

			mockLocalStorage.store[STORAGE_KEY] = JSON.stringify(custom);
			manager = new GameSettingsManager(USER_ID);

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(2000);
			expect(settings.dealerSpeed).toBe('fast');
			expect(settings.useLLM).toBe(true);
		});

		test('merges partial settings with defaults', () => {
			const partial = {
				startingChips: 1500,
				dealerSpeed: 'slow' as const,
			};

			mockLocalStorage.store[STORAGE_KEY] = JSON.stringify(partial);
			manager = new GameSettingsManager(USER_ID);

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1500);
			expect(settings.dealerSpeed).toBe('slow');
			expect(settings.minBet).toBe(DEFAULT_SETTINGS.minBet);
			expect(settings.maxBet).toBe(DEFAULT_SETTINGS.maxBet);
		});

		test('handles corrupted localStorage data', () => {
			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.store[STORAGE_KEY] = 'not-json';
				manager = new GameSettingsManager(USER_ID);

				const settings = manager.getSettings();
				expect(settings).toEqual(DEFAULT_SETTINGS);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});
		});

		test('handles localStorage.getItem throwing error', () => {
			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.getItem = mock(() => {
					throw new Error('localStorage unavailable');
				});

				manager = new GameSettingsManager(USER_ID);
				const settings = manager.getSettings();

				expect(settings).toEqual(DEFAULT_SETTINGS);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});
		});
	});

	describe('getSettings', () => {
		beforeEach(() => {
			manager = new GameSettingsManager(USER_ID);
		});

		test('returns a copy of settings', () => {
			const a = manager.getSettings();
			const b = manager.getSettings();

			expect(a).toEqual(b);
			expect(a).not.toBe(b);
		});

		test('modifying returned object does not affect internal state', () => {
			const settings = manager.getSettings();
			settings.startingChips = 9999;

			const next = manager.getSettings();
			expect(next.startingChips).toBe(DEFAULT_SETTINGS.startingChips);
		});
	});

	describe('updateSettings', () => {
		beforeEach(() => {
			manager = new GameSettingsManager(USER_ID);
		});

		test('updates single setting and saves to localStorage', () => {
			manager.updateSettings({ startingChips: 2000 });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(2000);
			expect(mockLocalStorage.setItem).toHaveBeenCalled();
			const saved = JSON.parse(mockLocalStorage.store[STORAGE_KEY]);
			expect(saved.startingChips).toBe(2000);
		});

		test('updates multiple settings', () => {
			manager.updateSettings({
				startingChips: 1500,
				minBet: 20,
				maxBet: 500,
				dealerSpeed: 'fast',
				useLLM: true,
			});

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1500);
			expect(settings.minBet).toBe(20);
			expect(settings.maxBet).toBe(500);
			expect(settings.dealerSpeed).toBe('fast');
			expect(settings.useLLM).toBe(true);
		});

		test('handles localStorage.setItem throwing error but keeps in-memory state', () => {
			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.setItem = mock(() => {
					throw new Error('localStorage full');
				});

				manager.updateSettings({ startingChips: 1800 });

				const settings = manager.getSettings();
				expect(settings.startingChips).toBe(1800);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});
		});
	});

	describe('resetToDefaults', () => {
		beforeEach(() => {
			manager = new GameSettingsManager(USER_ID);
		});

		test('resets all settings to defaults and saves', () => {
			manager.updateSettings({ startingChips: 1234, dealerSpeed: 'fast' });
			manager.resetToDefaults();

			const settings = manager.getSettings();
			expect(settings).toEqual(DEFAULT_SETTINGS);
			const saved = JSON.parse(mockLocalStorage.store[STORAGE_KEY]);
			expect(saved).toEqual(DEFAULT_SETTINGS);
		});

		test('handles localStorage.setItem throwing error during reset', () => {
			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.setItem = mock(() => {
					throw new Error('localStorage unavailable');
				});

				manager.resetToDefaults();

				const settings = manager.getSettings();
				expect(settings).toEqual(DEFAULT_SETTINGS);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});
		});
	});

	describe('getDealerDelay', () => {
		beforeEach(() => {
			manager = new GameSettingsManager(USER_ID);
		});

		test('returns correct delay for slow speed', () => {
			manager.updateSettings({ dealerSpeed: 'slow' });
			const delay = manager.getDealerDelay();
			expect(delay).toBe(1500);
		});

		test('returns correct delay for normal speed', () => {
			manager.updateSettings({ dealerSpeed: 'normal' });
			const delay = manager.getDealerDelay();
			expect(delay).toBe(1000);
		});

		test('returns correct delay for fast speed', () => {
			manager.updateSettings({ dealerSpeed: 'fast' });
			const delay = manager.getDealerDelay();
			expect(delay).toBe(500);
		});

		test('uses normal speed as default', () => {
			const delay = manager.getDealerDelay();
			expect(delay).toBe(1000);
		});
	});

	describe('persistence across instances', () => {
		test('settings persist across multiple instances for same user', () => {
			const m1 = new GameSettingsManager(USER_ID);
			m1.updateSettings({ startingChips: 2222, dealerSpeed: 'fast' });

			const m2 = new GameSettingsManager(USER_ID);
			const settings = m2.getSettings();
			expect(settings.startingChips).toBe(2222);
			expect(settings.dealerSpeed).toBe('fast');
		});

		test('settings are isolated per user id', () => {
			const m1 = new GameSettingsManager('user-a');
			m1.updateSettings({ startingChips: 1111 });

			const m2 = new GameSettingsManager('user-b');
			const settingsB = m2.getSettings();
			expect(settingsB.startingChips).toBe(DEFAULT_SETTINGS.startingChips);
		});
	});
});
