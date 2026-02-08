/**
 * Blackjack LLM Response Parsing
 *
 * Parses LLM responses for Blackjack strategy advice.
 */

import type { BlackjackAction } from './types';
import { extractBalancedJsonObjects } from '../llm-response-parsing';

export interface ParsedLLMResponse {
	recommendedAction: BlackjackAction | null;
	reasoning: string;
	confidence: number;
}

/**
 * Parse LLM response into structured Blackjack advice
 */
export function parseLLMResponse(
	response: string,
	availableActions: BlackjackAction[],
	deps: { extractJson?: typeof extractBalancedJsonObjects } = {},
): ParsedLLMResponse | null {
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
		const action = String(parsedObj.action ?? '')
			.toLowerCase()
			.replaceAll('_', '-');
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
