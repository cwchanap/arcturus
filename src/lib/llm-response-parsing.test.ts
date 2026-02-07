/**
 * LLM Response Parsing Unit Tests
 *
 * Tests for parsing JSON responses from LLM APIs.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import type { BlackjackAction } from './blackjack/types';

// Exported for testing/mocking purposes
export function extractBalancedJsonObjects(input: string): string[] {
	const results: string[] = [];
	let braceCount = 0;
	let start = -1;
	let inString = false;
	let escapeNext = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (char === '\\' && inString) {
			escapeNext = true;
			continue;
		}

		if (char === '"') {
			inString = !inString;
			continue;
		}

		if (!inString) {
			if (char === '{') {
				if (braceCount === 0) {
					start = i;
				}
				braceCount++;
			} else if (char === '}') {
				braceCount--;
				if (braceCount === 0 && start !== -1) {
					results.push(input.substring(start, i + 1));
					start = -1;
				}
			}
		}
	}

	return results;
}

function parseLLMResponse(
	response: string,
	availableActions: BlackjackAction[],
	deps: { extractJson?: typeof extractBalancedJsonObjects } = {},
): { recommendedAction: BlackjackAction | null; reasoning: string; confidence: number } | null {
	try {
		// Use balanced-brace extraction to correctly handle nested JSON
		const extractor = deps.extractJson ?? extractBalancedJsonObjects;
		const jsonMatches = extractor(response);
		if (jsonMatches.length === 0) {
			return null;
		}

		// Try parsing each match until one succeeds
		let parsed: unknown = null;
		for (const match of jsonMatches) {
			try {
				parsed = JSON.parse(match);
				break; // Success, exit the loop
			} catch {
				// Continue to try the next match
				continue;
			}
		}

		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const parsedObj = parsed as Record<string, unknown>;
		const action = String(parsedObj.action ?? '').toLowerCase().replaceAll('_', '-');
		const reasoning = typeof parsedObj.reasoning === 'string' ? parsedObj.reasoning : '';

		const validActions: BlackjackAction[] = ['hit', 'stand', 'double-down', 'split'];
		if (!action || !validActions.includes(action as BlackjackAction)) {
			return null;
		}

		const recommendedAction = action as BlackjackAction;
		const isAvailable = availableActions.includes(recommendedAction);

		return {
			recommendedAction: isAvailable ? recommendedAction : null,
			reasoning: isAvailable
				? reasoning
				: `${reasoning} (Note: ${recommendedAction} is not available, consider alternatives)`,
			confidence: isAvailable ? 0.85 : 0.5,
		};
	} catch (_error) {
		return null;
	}
}

describe('LLM Response Parsing', () => {
	describe('Valid JSON Responses', () => {
		test('parses valid hit action response', () => {
			const response = '{"action":"hit","reasoning":"Hit to improve hand"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('hit');
			expect(result?.reasoning).toBe('Hit to improve hand');
			expect(result?.confidence).toBe(0.85);
		});

		test('parses valid stand action response', () => {
			const response = '{"action":"stand","reasoning":"Stand to avoid busting"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('stand');
			expect(result?.reasoning).toBe('Stand to avoid busting');
		});

		test('parses valid double-down action response', () => {
			const response = '{"action":"double-down","reasoning":"Double down on 11"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand', 'double-down'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('double-down');
			expect(result?.reasoning).toBe('Double down on 11');
		});

		test('parses valid split action response', () => {
			const response = '{"action":"split","reasoning":"Always split aces"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand', 'split'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('split');
			expect(result?.reasoning).toBe('Always split aces');
		});

		test('handles action with underscores', () => {
			const response = '{"action":"double_down","reasoning":"Double down"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand', 'double-down'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('double-down');
		});

		test('handles mixed case action', () => {
			const response = '{"action":"HIT","reasoning":"Take a card"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('hit');
		});
	});

	describe('Invalid JSON Responses', () => {
		test('returns null for non-JSON response', () => {
			const response = 'Just some text without JSON';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).toBeNull();
		});

		test('returns null for malformed JSON', () => {
			const response = '{"action":"hit","reasoning":missing quotes}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).toBeNull();
		});

		test('returns null for missing action field', () => {
			const response = '{"reasoning":"No action provided"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).toBeNull();
		});

		test('returns null for invalid action value', () => {
			const response = '{"action":"invalid","reasoning":"Bad action"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).toBeNull();
		});

		test('returns null when no JSON object found', () => {
			const response = '["array","instead","of","object"]';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).toBeNull();
		});

		test('returns null when parsed value is not an object', () => {
			// Mock extractBalancedJsonObjects to return a JSON string that parses to a non-object
			const mockResponse = '{"action":"hit"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			// Inject a mock that returns a JSON number string
			const result = parseLLMResponse(mockResponse, availableActions, {
				extractJson: () => ['123'],
			});

			expect(result).toBeNull();
		});
	});

	describe('Available Actions Validation', () => {
		test('returns object with null recommendedAction when recommended action is not available', () => {
			const response = '{"action":"double-down","reasoning":"Double down"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBeNull();
			expect(result?.reasoning).toContain('double-down is not available');
			expect(result?.confidence).toBe(0.5);
		});

		test('validates action against available list', () => {
			const response = '{"action":"split","reasoning":"Split the pair"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand', 'split'];

			const result = parseLLMResponse(response, availableActions);

			expect(result?.recommendedAction).toBe('split');
			expect(result?.confidence).toBe(0.85);
		});
	});

	describe('Edge Cases', () => {
		test('extracts JSON from response with extra text', () => {
			const response =
				'Here is my advice: {"action":"hit","reasoning":"Take a card"} and more text';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('hit');
		});

		test('handles missing reasoning field', () => {
			const response = '{"action":"hit"}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('hit');
			expect(result?.reasoning).toBe('');
		});

		test('handles non-string reasoning', () => {
			const response = '{"action":"stand","reasoning":123}';
			const availableActions: BlackjackAction[] = ['hit', 'stand'];

			const result = parseLLMResponse(response, availableActions);

			expect(result).not.toBeNull();
			expect(result?.recommendedAction).toBe('stand');
			expect(result?.reasoning).toBe('');
		});
	});
});
