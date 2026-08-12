import { afterEach, expect, test } from 'bun:test';
import {
	AI_SETTINGS_STORAGE_KEY,
	clearAiSettings,
	isValidModel,
	isValidProvider,
	loadAiSettings,
	saveAiSettings,
} from './settings';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: {
		getItem: (key: string) => memory.get(key) ?? null,
		setItem: (key: string, value: string) => void memory.set(key, value),
		removeItem: (key: string) => void memory.delete(key),
	},
});

afterEach(() => memory.clear());

test('reuses the current provider/model validation contract', () => {
	expect(isValidProvider('openai')).toBe(true);
	expect(isValidProvider('other')).toBe(false);
	expect(isValidModel('openai', 'gpt-4o')).toBe(true);
	expect(isValidModel('openai', 'gemini-2.5-flash')).toBe(false);
});

test('save replaces the one active record and trims the key', () => {
	saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: ' sk-test ' });
	expect(loadAiSettings()).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });

	saveAiSettings({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' });
	expect(loadAiSettings()).toEqual({
		provider: 'gemini',
		model: 'gemini-2.5-flash',
		apiKey: 'AIza-test',
	});
});

test('load ignores garbage while save rejects invalid records', () => {
	localStorage.setItem(AI_SETTINGS_STORAGE_KEY, '{broken');
	expect(loadAiSettings()).toBeNull();
	expect(() => saveAiSettings({ provider: 'openai', model: 'bad-model', apiKey: 'x' })).toThrow();
	expect(() => saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: '   ' })).toThrow();
});

test('clear removes the current record', () => {
	saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
	clearAiSettings();
	expect(loadAiSettings()).toBeNull();
});
