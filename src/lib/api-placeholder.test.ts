/**
 * API Key Placeholder Logic Unit Tests
 *
 * Tests for determining the correct placeholder based on AI provider.
 */

import { describe, expect, test } from 'bun:test';
import { getApiKeyPlaceholder } from './api-placeholder';

describe('API Key Placeholder Logic', () => {
	test.each([
		['openai', 'sk-...'],
		['gemini', 'AIza...'],
	])('returns correct placeholder for %s provider', (provider: string, expected: string) => {
		expect(getApiKeyPlaceholder(provider as 'openai' | 'gemini')).toBe(expected);
	});
});
