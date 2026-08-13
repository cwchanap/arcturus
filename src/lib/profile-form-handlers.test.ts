import { afterEach, expect, test } from 'bun:test';
import { saveAiSettingsFromForm } from './profile-form-handlers';
import type { AiSettings } from './ai';

function installMemoryStorage(): Storage {
	const store = new Map<string, string>();
	const storage: Storage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => store.clear(),
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		get length() {
			return store.size;
		},
	};
	(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = storage;
	return storage;
}

const globalWithStorage = globalThis as unknown as { localStorage?: Storage };
const originalLocalStorage = globalWithStorage.localStorage;

afterEach(() => {
	if (originalLocalStorage === undefined) {
		delete globalWithStorage.localStorage;
	} else {
		globalWithStorage.localStorage = originalLocalStorage;
	}
});

test('masked input recovers the edited draft from previous when provider matches', () => {
	installMemoryStorage();
	// Simulate the hide handler capturing an edited key into the in-memory draft.
	const editedPrevious: AiSettings = {
		provider: 'openai',
		model: 'gpt-4o',
		apiKey: 'sk-edited-draft',
	};

	// After hide, the field shows the mask; save must submit the edited draft,
	// not the stale stored value.
	const result = saveAiSettingsFromForm('openai', 'gpt-4o', '••••••••••••••••', editedPrevious);

	expect(result.apiKey).toBe('sk-edited-draft');
	expect(result.provider).toBe('openai');
});

test('unmasked edited input is submitted directly', () => {
	installMemoryStorage();
	const previous: AiSettings = {
		provider: 'openai',
		model: 'gpt-4o',
		apiKey: 'sk-old',
	};

	const result = saveAiSettingsFromForm('openai', 'gpt-4o', 'sk-brand-new', previous);

	expect(result.apiKey).toBe('sk-brand-new');
});

test('masked input with a different provider is rejected as API key required', () => {
	installMemoryStorage();
	const previous: AiSettings = {
		provider: 'openai',
		model: 'gpt-4o',
		apiKey: 'sk-openai-key',
	};

	// A masked display value is never persistence data. Switching provider
	// invalidates the masked draft, so the helper must reject rather than
	// persist the mask as a real key.
	expect(() => saveAiSettingsFromForm('gemini', 'gemini-2.5-flash', '•••••', previous)).toThrow(
		'API key required',
	);
});
