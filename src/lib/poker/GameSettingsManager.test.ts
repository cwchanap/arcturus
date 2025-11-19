import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { GameSettingsManager } from './GameSettingsManager';
import { DEFAULT_SETTINGS } from './types';
import type { GameSettings } from './types';

describe('GameSettingsManager', () => {
	let manager: GameSettingsManager;
	let mockLocalStorage: {
		store: Record<string, string>;
		getItem: ReturnType<typeof mock>;
		setItem: ReturnType<typeof mock>;
		clear: () => void;
	};
	let originalLocalStorage: Storage;

	// Helper function to mock console.error and ensure proper cleanup
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
		// Save original localStorage
		originalLocalStorage = global.localStorage;

		// Create mock localStorage
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

		// Replace global localStorage with mock
		global.localStorage = mockLocalStorage as unknown as Storage;
	});

	afterEach(() => {
		mockLocalStorage.clear();
		// Restore original localStorage to avoid polluting other test suites
		global.localStorage = originalLocalStorage;
	});

	describe('Constructor and Initialization', () => {
		test('initializes with default settings when localStorage is empty', () => {
			manager = new GameSettingsManager();
			const settings = manager.getSettings();

			expect(settings).toEqual(DEFAULT_SETTINGS);
		});

		test('loads settings from localStorage when available', () => {
			const customSettings: GameSettings = {
				...DEFAULT_SETTINGS,
				startingChips: 1000,
				aiSpeed: 'fast',
			};

			mockLocalStorage.store['poker_game_settings'] = JSON.stringify(customSettings);
			manager = new GameSettingsManager();

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);
			expect(settings.aiSpeed).toBe('fast');
		});

		test('merges partial settings with defaults', () => {
			const partialSettings = {
				startingChips: 1000,
				aiSpeed: 'fast',
			};

			mockLocalStorage.store['poker_game_settings'] = JSON.stringify(partialSettings);
			manager = new GameSettingsManager();

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);
			expect(settings.aiSpeed).toBe('fast');
			expect(settings.smallBlind).toBe(DEFAULT_SETTINGS.smallBlind);
			expect(settings.bigBlind).toBe(DEFAULT_SETTINGS.bigBlind);
			expect(settings.aiPersonality1).toBe(DEFAULT_SETTINGS.aiPersonality1);
			expect(settings.aiPersonality2).toBe(DEFAULT_SETTINGS.aiPersonality2);
			expect(settings.useLLMAI).toBe(DEFAULT_SETTINGS.useLLMAI);
		});

		test('handles corrupted localStorage data', () => {
			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.store['poker_game_settings'] = 'invalid json {{{';
				manager = new GameSettingsManager();

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

				manager = new GameSettingsManager();
				const settings = manager.getSettings();

				expect(settings).toEqual(DEFAULT_SETTINGS);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});
		});
	});

	describe('getSettings()', () => {
		beforeEach(() => {
			manager = new GameSettingsManager();
		});

		test('returns a copy of settings, not the original', () => {
			const settings1 = manager.getSettings();
			const settings2 = manager.getSettings();

			expect(settings1).toEqual(settings2);
			expect(settings1).not.toBe(settings2); // Different object references
		});

		test('returns current settings after update', () => {
			manager.updateSettings({ startingChips: 2000 });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(2000);
		});

		test('modifying returned settings does not affect internal state', () => {
			const settings = manager.getSettings();
			settings.startingChips = 9999;

			const newSettings = manager.getSettings();
			expect(newSettings.startingChips).toBe(DEFAULT_SETTINGS.startingChips);
		});
	});

	describe('updateSettings()', () => {
		beforeEach(() => {
			manager = new GameSettingsManager();
		});

		test('updates single setting', () => {
			manager.updateSettings({ startingChips: 1000 });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);
			expect(settings.smallBlind).toBe(DEFAULT_SETTINGS.smallBlind);
		});

		test('updates multiple settings', () => {
			manager.updateSettings({
				startingChips: 1000,
				smallBlind: 10,
				bigBlind: 20,
				aiSpeed: 'fast',
			});

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);
			expect(settings.smallBlind).toBe(10);
			expect(settings.bigBlind).toBe(20);
			expect(settings.aiSpeed).toBe('fast');
		});

		test('updates AI personality settings', () => {
			manager.updateSettings({
				aiPersonality1: 'loose-passive',
				aiPersonality2: 'tight-passive',
			});

			const settings = manager.getSettings();
			expect(settings.aiPersonality1).toBe('loose-passive');
			expect(settings.aiPersonality2).toBe('tight-passive');
		});

		test('updates LLM AI setting', () => {
			manager.updateSettings({ useLLMAI: true });

			const settings = manager.getSettings();
			expect(settings.useLLMAI).toBe(true);
		});

		test('saves to localStorage after update', () => {
			manager.updateSettings({ startingChips: 1500 });

			expect(mockLocalStorage.setItem).toHaveBeenCalled();
			const savedData = mockLocalStorage.store['poker_game_settings'];
			const parsed = JSON.parse(savedData);
			expect(parsed.startingChips).toBe(1500);
		});

		test('handles localStorage.setItem throwing error', () => {
			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.setItem = mock(() => {
					throw new Error('localStorage full');
				});

				manager.updateSettings({ startingChips: 1500 });

				// Settings should still be updated in memory
				const settings = manager.getSettings();
				expect(settings.startingChips).toBe(1500);
				expect(consoleErrorSpy).toHaveBeenCalled();
			});
		});

		test('preserves other settings when updating partial settings', () => {
			manager.updateSettings({ startingChips: 1000 });
			manager.updateSettings({ aiSpeed: 'fast' });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);
			expect(settings.aiSpeed).toBe('fast');
			expect(settings.smallBlind).toBe(DEFAULT_SETTINGS.smallBlind);
		});

		test('can update same setting multiple times', () => {
			manager.updateSettings({ startingChips: 1000 });
			manager.updateSettings({ startingChips: 2000 });
			manager.updateSettings({ startingChips: 3000 });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(3000);
		});
	});

	describe('resetToDefaults()', () => {
		beforeEach(() => {
			manager = new GameSettingsManager();
		});

		test('resets all settings to defaults', () => {
			manager.updateSettings({
				startingChips: 1000,
				smallBlind: 10,
				bigBlind: 20,
				aiSpeed: 'fast',
				aiPersonality1: 'loose-passive',
				aiPersonality2: 'tight-passive',
				useLLMAI: true,
			});

			manager.resetToDefaults();

			const settings = manager.getSettings();
			expect(settings).toEqual(DEFAULT_SETTINGS);
		});

		test('saves defaults to localStorage', () => {
			manager.updateSettings({ startingChips: 1000 });
			manager.resetToDefaults();

			const savedData = mockLocalStorage.store['poker_game_settings'];
			const parsed = JSON.parse(savedData);
			expect(parsed).toEqual(DEFAULT_SETTINGS);
		});

		test('can update settings after reset', () => {
			manager.updateSettings({ startingChips: 1000 });
			manager.resetToDefaults();
			manager.updateSettings({ startingChips: 2000 });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(2000);
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

	describe('getAIDelay()', () => {
		beforeEach(() => {
			manager = new GameSettingsManager();
		});

		test('returns correct delay for slow speed', () => {
			manager.updateSettings({ aiSpeed: 'slow' });

			const delay = manager.getAIDelay();
			expect(delay.min).toBe(1500);
			expect(delay.max).toBe(2500);
		});

		test('returns correct delay for normal speed', () => {
			manager.updateSettings({ aiSpeed: 'normal' });

			const delay = manager.getAIDelay();
			expect(delay.min).toBe(800);
			expect(delay.max).toBe(1500);
		});

		test('returns correct delay for fast speed', () => {
			manager.updateSettings({ aiSpeed: 'fast' });

			const delay = manager.getAIDelay();
			expect(delay.min).toBe(300);
			expect(delay.max).toBe(600);
		});

		test('returns normal delay as default', () => {
			const delay = manager.getAIDelay();
			expect(delay.min).toBe(800);
			expect(delay.max).toBe(1500);
		});

		test('min delay is always less than max delay', () => {
			const speeds: Array<'slow' | 'normal' | 'fast'> = ['slow', 'normal', 'fast'];

			for (const speed of speeds) {
				manager.updateSettings({ aiSpeed: speed });
				const delay = manager.getAIDelay();
				expect(delay.min).toBeLessThan(delay.max);
			}
		});

		test('delay updates when speed setting changes', () => {
			manager.updateSettings({ aiSpeed: 'slow' });
			const slowDelay = manager.getAIDelay();

			manager.updateSettings({ aiSpeed: 'fast' });
			const fastDelay = manager.getAIDelay();

			expect(fastDelay.min).toBeLessThan(slowDelay.min);
			expect(fastDelay.max).toBeLessThan(slowDelay.max);
		});
	});

	describe('Persistence across instances', () => {
		test('settings persist across multiple instances', () => {
			const manager1 = new GameSettingsManager();
			manager1.updateSettings({ startingChips: 1500, aiSpeed: 'fast' });

			// Create a new instance - should load saved settings
			const manager2 = new GameSettingsManager();
			const settings = manager2.getSettings();

			expect(settings.startingChips).toBe(1500);
			expect(settings.aiSpeed).toBe('fast');
		});

		test('reset in one instance affects new instances', () => {
			const manager1 = new GameSettingsManager();
			manager1.updateSettings({ startingChips: 1500 });
			manager1.resetToDefaults();

			const manager2 = new GameSettingsManager();
			const settings = manager2.getSettings();

			expect(settings).toEqual(DEFAULT_SETTINGS);
		});
	});

	describe('Edge cases and validation', () => {
		beforeEach(() => {
			manager = new GameSettingsManager();
		});

		test('handles empty update object', () => {
			const originalSettings = manager.getSettings();
			manager.updateSettings({});

			const settings = manager.getSettings();
			expect(settings).toEqual(originalSettings);
		});

		test('preserves null values from localStorage over defaults', () => {
			mockLocalStorage.store['poker_game_settings'] = JSON.stringify({
				...DEFAULT_SETTINGS,
				startingChips: null,
			});

			const manager2 = new GameSettingsManager();
			const settings = manager2.getSettings();

			// Null values in localStorage overwrite defaults due to spread operator
			expect(settings.startingChips).toBe(null);
		});

		test('multiple rapid updates are handled correctly', () => {
			for (let i = 0; i < 10; i++) {
				manager.updateSettings({ startingChips: i });
			}

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(9);
		});

		test('settings remain consistent after multiple operations', () => {
			manager.updateSettings({ startingChips: 1000 });
			manager.updateSettings({ aiSpeed: 'fast' });
			manager.getSettings();
			manager.updateSettings({ smallBlind: 20 });
			manager.getAIDelay();
			manager.updateSettings({ bigBlind: 40 });

			const settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);
			expect(settings.aiSpeed).toBe('fast');
			expect(settings.smallBlind).toBe(20);
			expect(settings.bigBlind).toBe(40);
		});
	});

	describe('Integration scenarios', () => {
		test('complete settings workflow', () => {
			// Initialize with defaults
			manager = new GameSettingsManager();
			expect(manager.getSettings()).toEqual(DEFAULT_SETTINGS);

			// Update some settings
			manager.updateSettings({
				startingChips: 1000,
				smallBlind: 10,
				bigBlind: 20,
			});

			// Verify updates
			let settings = manager.getSettings();
			expect(settings.startingChips).toBe(1000);

			// Get AI delay based on current speed
			let delay = manager.getAIDelay();
			expect(delay.min).toBe(800); // normal speed

			// Change AI speed
			manager.updateSettings({ aiSpeed: 'fast' });
			delay = manager.getAIDelay();
			expect(delay.min).toBe(300);

			// Reset to defaults
			manager.resetToDefaults();
			settings = manager.getSettings();
			expect(settings).toEqual(DEFAULT_SETTINGS);

			// Verify persistence
			const newManager = new GameSettingsManager();
			expect(newManager.getSettings()).toEqual(DEFAULT_SETTINGS);
		});

		test('settings survive localStorage errors', () => {
			manager = new GameSettingsManager();
			manager.updateSettings({ startingChips: 1500 });

			withMockedConsoleError((consoleErrorSpy) => {
				mockLocalStorage.setItem = mock(() => {
					throw new Error('localStorage full');
				});

				// Settings should still work in memory
				manager.updateSettings({ aiSpeed: 'fast' });
				const settings = manager.getSettings();
				expect(settings.startingChips).toBe(1500);
				expect(settings.aiSpeed).toBe('fast');
			});
		});
	});
});
