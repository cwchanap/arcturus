import { eq } from 'drizzle-orm';
import { llmSettings } from '../db/schema';
import type { Database } from './db';

export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_MODELS: Record<AiProvider, readonly string[]> = {
	openai: ['gpt-4o'],
	gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
} as const;

export interface LlmSettingsInput {
	provider: AiProvider;
	model: string;
	openaiApiKey?: string | null;
	geminiApiKey?: string | null;
}

export interface LlmSettingsResult extends LlmSettingsInput {
	createdAt: Date;
	updatedAt: Date;
}

const DEFAULT_SETTINGS: LlmSettingsResult = {
	provider: 'openai',
	model: 'gpt-4o',
	openaiApiKey: null,
	geminiApiKey: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

export async function getLlmSettings(db: Database, userId: string): Promise<LlmSettingsResult> {
	const [current] = await db
		.select({
			provider: llmSettings.provider,
			model: llmSettings.model,
			openaiApiKey: llmSettings.openaiApiKey,
			geminiApiKey: llmSettings.geminiApiKey,
			createdAt: llmSettings.createdAt,
			updatedAt: llmSettings.updatedAt,
		})
		.from(llmSettings)
		.where(eq(llmSettings.userId, userId))
		.limit(1);

	if (!current) {
		return { ...DEFAULT_SETTINGS };
	}

	return {
		provider: (current.provider as AiProvider) ?? DEFAULT_SETTINGS.provider,
		model: current.model ?? DEFAULT_SETTINGS.model,
		openaiApiKey: current.openaiApiKey ?? null,
		geminiApiKey: current.geminiApiKey ?? null,
		createdAt: new Date(current.createdAt),
		updatedAt: new Date(current.updatedAt),
	};
}

export async function upsertLlmSettings(db: Database, userId: string, input: LlmSettingsInput) {
	const now = new Date();

	// Get existing settings to preserve keys not being updated
	const existing = await getLlmSettings(db, userId);

	// Only update the key for the current provider
	// - If key is undefined (not in payload), preserve existing key
	// - If key is null or empty string, clear the key (allow revocation)
	// - If key is a non-empty string, store the new key
	const openaiKey =
		input.provider === 'openai'
			? input.openaiApiKey !== undefined
				? input.openaiApiKey
				: existing.openaiApiKey
			: existing.openaiApiKey;
	const geminiKey =
		input.provider === 'gemini'
			? input.geminiApiKey !== undefined
				? input.geminiApiKey
				: existing.geminiApiKey
			: existing.geminiApiKey;

	await db
		.insert(llmSettings)
		.values({
			userId,
			provider: input.provider,
			model: input.model,
			openaiApiKey: openaiKey,
			geminiApiKey: geminiKey,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: llmSettings.userId,
			set: {
				provider: input.provider,
				model: input.model,
				openaiApiKey: openaiKey,
				geminiApiKey: geminiKey,
				updatedAt: now,
			},
		});
}

export function isValidProvider(provider: string): provider is AiProvider {
	return AI_PROVIDERS.includes(provider as AiProvider);
}

export function isValidModel(provider: AiProvider, model: string): boolean {
	return AI_MODELS[provider]?.includes(model) ?? false;
}
