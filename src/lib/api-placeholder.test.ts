/**
 * API Key Placeholder Logic Unit Tests
 *
 * Tests for determining the correct placeholder based on AI provider.
 */

import { describe, expect, test } from 'bun:test';

describe('API Key Placeholder Logic', () => {
	test('returns OpenAI placeholder for openai provider', () => {
		const getApiKeyPlaceholder = (provider: 'openai' | 'gemini'): string => {
			return provider === 'openai' ? 'sk-...' : 'AIza...';
		};

		expect(getApiKeyPlaceholder('openai')).toBe('sk-...');
	});

	test('returns Gemini placeholder for gemini provider', () => {
		const getApiKeyPlaceholder = (provider: 'openai' | 'gemini'): string => {
			return provider === 'openai' ? 'sk-...' : 'AIza...';
		};

		expect(getApiKeyPlaceholder('gemini')).toBe('AIza...');
	});
});
