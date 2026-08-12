/**
 * LLM Settings Tests
 *
 * Tests for database operations and validation helpers in llm-settings.ts
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from './db';
import {
	AI_MODELS,
	AI_PROVIDERS,
	getLlmSettings,
	isValidModel,
	isValidProvider,
	upsertLlmSettings,
} from './llm-settings';

/**
 * Mock database implementation that simulates Drizzle ORM query chains
 * for the llm_settings table (select/insert with where/limit/onConflictDoUpdate).
 */
function createMockDb({
	selectResult = [],
	insertResult,
}: {
	selectResult?: any[];
	insertResult?: any;
} = {}): Database & {
	capturedInsertValues?: any;
	capturedConflictSet?: any;
} {
	const captured: { insertValues?: any; conflictSet?: any } = {};

	// Create a thenable that supports both await and .limit() chaining
	const createWhereThenable = (fullResult: any[], limitedResult: any[]) => {
		const promise = Promise.resolve(fullResult) as Promise<any[]> & {
			limit: () => Promise<any[]>;
		};
		promise.limit = () => Promise.resolve(limitedResult);
		return promise;
	};

	const db = {
		select: () => ({
			from: () => ({
				where: () => createWhereThenable(selectResult, selectResult.slice(0, 1)),
			}),
		}),
		insert: () => ({
			values: (values: any) => {
				captured.insertValues = values;
				return {
					onConflictDoUpdate: (conflictUpdate: { set: Record<string, unknown> }) => {
						captured.conflictSet = conflictUpdate.set;
						return Promise.resolve(insertResult ?? undefined);
					},
				};
			},
		}),
	} as unknown as Database & {
		capturedInsertValues?: any;
		capturedConflictSet?: any;
	};

	Object.defineProperty(db, 'capturedInsertValues', {
		get: () => captured.insertValues,
	});
	Object.defineProperty(db, 'capturedConflictSet', {
		get: () => captured.conflictSet,
	});

	return db;
}

describe('isValidProvider', () => {
	test('returns true for valid providers', () => {
		for (const provider of AI_PROVIDERS) {
			expect(isValidProvider(provider)).toBe(true);
		}
	});

	test('returns false for invalid provider', () => {
		expect(isValidProvider('anthropic')).toBe(false);
		expect(isValidProvider('')).toBe(false);
		expect(isValidProvider('OPENAI')).toBe(false);
	});

	test('narrows the type for valid providers', () => {
		const candidate: string = 'gemini';
		if (isValidProvider(candidate)) {
			// candidate is now AiProvider; index into AI_MODELS
			expect(AI_MODELS[candidate]).toBeDefined();
		}
	});
});

describe('isValidModel', () => {
	test('returns true for valid openai models', () => {
		expect(isValidModel('openai', 'gpt-4o')).toBe(true);
	});

	test('returns true for valid gemini models', () => {
		expect(isValidModel('gemini', 'gemini-2.5-flash')).toBe(true);
		expect(isValidModel('gemini', 'gemini-2.5-flash-lite')).toBe(true);
	});

	test('returns false for invalid model under a valid provider', () => {
		expect(isValidModel('openai', 'gpt-3.5')).toBe(false);
		expect(isValidModel('gemini', 'gpt-4o')).toBe(false);
	});

	test('returns false for empty model string', () => {
		expect(isValidModel('openai', '')).toBe(false);
	});

	test('returns false for unknown provider (optional chaining fallback)', () => {
		// Cast to AiProvider to exercise the `?? false` branch when
		// AI_MODELS[provider] is undefined.
		expect(isValidModel('anthropic' as any, 'claude-3')).toBe(false);
	});
});

describe('getLlmSettings', () => {
	test('returns default settings when no row exists', async () => {
		const mockDb = createMockDb({ selectResult: [] });

		const result = await getLlmSettings(mockDb, 'user-1');
		expect(result).toEqual({
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: null,
			geminiApiKey: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
	});

	test('returns mapped settings when a row exists', async () => {
		const createdAt = new Date('2024-01-01T00:00:00Z');
		const updatedAt = new Date('2024-06-01T12:00:00Z');
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: 'gemini',
					model: 'gemini-2.5-flash',
					openaiApiKey: 'sk-old',
					geminiApiKey: 'gem-key',
					createdAt,
					updatedAt,
				},
			],
		});

		const result = await getLlmSettings(mockDb, 'user-1');
		expect(result).toEqual({
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			openaiApiKey: 'sk-old',
			geminiApiKey: 'gem-key',
			createdAt: new Date(createdAt),
			updatedAt: new Date(updatedAt),
		});
	});

	test('falls back to defaults when row fields are null', async () => {
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: null,
					model: null,
					openaiApiKey: null,
					geminiApiKey: null,
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
		});

		const result = await getLlmSettings(mockDb, 'user-1');
		expect(result.provider).toBe('openai');
		expect(result.model).toBe('gpt-4o');
		expect(result.openaiApiKey).toBeNull();
		expect(result.geminiApiKey).toBeNull();
	});

	test('coerces createdAt/updatedAt into Date instances', async () => {
		const ts = new Date('2024-03-15T08:30:00Z');
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: 'openai',
					model: 'gpt-4o',
					openaiApiKey: null,
					geminiApiKey: null,
					createdAt: ts,
					updatedAt: ts,
				},
			],
		});

		const result = await getLlmSettings(mockDb, 'user-1');
		expect(result.createdAt).toBeInstanceOf(Date);
		expect(result.updatedAt).toBeInstanceOf(Date);
		expect(result.createdAt.getTime()).toBe(new Date(ts).getTime());
	});
});

describe('upsertLlmSettings', () => {
	test('inserts with new keys for the current provider (openai)', async () => {
		const mockDb = createMockDb({ selectResult: [] });

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'sk-new',
		});

		expect(mockDb.capturedInsertValues).toMatchObject({
			userId: 'user-1',
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'sk-new',
			geminiApiKey: null,
		});
		expect(mockDb.capturedConflictSet).toMatchObject({
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'sk-new',
			geminiApiKey: null,
		});
	});

	test('inserts with new keys for the current provider (gemini)', async () => {
		const mockDb = createMockDb({ selectResult: [] });

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			geminiApiKey: 'gem-new',
		});

		expect(mockDb.capturedInsertValues).toMatchObject({
			userId: 'user-1',
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			openaiApiKey: null,
			geminiApiKey: 'gem-new',
		});
	});

	test('preserves existing keys when key is undefined in payload', async () => {
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: 'openai',
					model: 'gpt-4o',
					openaiApiKey: 'sk-existing',
					geminiApiKey: 'gem-existing',
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
		});

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'openai',
			model: 'gpt-4o',
			// openaiApiKey omitted -> preserve existing
		});

		expect(mockDb.capturedInsertValues).toMatchObject({
			openaiApiKey: 'sk-existing',
			geminiApiKey: 'gem-existing',
		});
		expect(mockDb.capturedConflictSet).toMatchObject({
			openaiApiKey: 'sk-existing',
			geminiApiKey: 'gem-existing',
		});
	});

	test('clears the key when null is provided (revocation)', async () => {
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: 'openai',
					model: 'gpt-4o',
					openaiApiKey: 'sk-existing',
					geminiApiKey: null,
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
		});

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: null,
		});

		expect(mockDb.capturedInsertValues).toMatchObject({
			openaiApiKey: null,
		});
	});

	test('clears the key when empty string is provided (revocation)', async () => {
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: 'gemini',
					model: 'gemini-2.5-flash',
					openaiApiKey: null,
					geminiApiKey: 'gem-existing',
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
		});

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			geminiApiKey: '',
		});

		expect(mockDb.capturedInsertValues).toMatchObject({
			geminiApiKey: '',
		});
	});

	test('preserves the non-current provider key from existing row', async () => {
		const mockDb = createMockDb({
			selectResult: [
				{
					provider: 'openai',
					model: 'gpt-4o',
					openaiApiKey: 'sk-existing',
					geminiApiKey: 'gem-existing',
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
		});

		// Switching to gemini should preserve the existing openai key
		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			geminiApiKey: 'gem-new',
		});

		expect(mockDb.capturedInsertValues).toMatchObject({
			provider: 'gemini',
			openaiApiKey: 'sk-existing',
			geminiApiKey: 'gem-new',
		});
	});

	test('sets createdAt and updatedAt to the current time on insert', async () => {
		const mockDb = createMockDb({ selectResult: [] });
		const before = Date.now();

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'sk-new',
		});

		const after = Date.now();
		const insertedAt = mockDb.capturedInsertValues.createdAt as Date;
		expect(insertedAt).toBeInstanceOf(Date);
		expect(insertedAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(insertedAt.getTime()).toBeLessThanOrEqual(after);
		expect(mockDb.capturedConflictSet.updatedAt).toBe(insertedAt);
	});

	test('conflict set does not include createdAt (only updatedAt)', async () => {
		const mockDb = createMockDb({ selectResult: [] });

		await upsertLlmSettings(mockDb, 'user-1', {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'sk-new',
		});

		expect(mockDb.capturedConflictSet).not.toHaveProperty('createdAt');
		expect(mockDb.capturedConflictSet).toHaveProperty('updatedAt');
	});
});
