import type { AiProvider, AiSettings } from './types';

export const AI_SETTINGS_STORAGE_KEY = 'arcturus-ai-settings';
export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export const AI_MODELS: Record<AiProvider, readonly string[]> = {
	openai: ['gpt-4o'],
	gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};

export function isValidProvider(value: string): value is AiProvider {
	return AI_PROVIDERS.includes(value as AiProvider);
}

export function isValidModel(provider: AiProvider, model: string): boolean {
	return AI_MODELS[provider]?.includes(model) ?? false;
}

function isAiSettings(value: unknown): value is AiSettings {
	if (!value || typeof value !== 'object') return false;
	const item = value as Partial<AiSettings>;
	return (
		typeof item.provider === 'string' &&
		isValidProvider(item.provider) &&
		typeof item.model === 'string' &&
		isValidModel(item.provider, item.model) &&
		typeof item.apiKey === 'string' &&
		item.apiKey.trim().length > 0
	);
}

export function loadAiSettings(): AiSettings | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		return isAiSettings(value) ? value : null;
	} catch {
		return null;
	}
}

export function saveAiSettings(settings: AiSettings): void {
	if (!isValidProvider(settings.provider) || !isValidModel(settings.provider, settings.model)) {
		throw new Error('Unsupported AI provider or model');
	}
	const apiKey = settings.apiKey.trim();
	if (!apiKey) throw new Error('API key is required');
	localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify({ ...settings, apiKey }));
}

export function clearAiSettings(): void {
	localStorage.removeItem(AI_SETTINGS_STORAGE_KEY);
}
