/**
 * Deterministic Blackjack strategy with an optional provider explanation.
 *
 * The local strategy always owns the recommended action. A configured AI
 * provider may only rewrite the explanation for that already-selected move.
 */

import { generateAiJson, type AiSettings } from '../ai';
import { calculateHandValue } from './handEvaluator';
import type { Card, BlackjackAction, Hand } from './types';

export interface BlackjackAdviceContext {
	playerHand: Hand;
	dealerUpCard: Card;
	availableActions: BlackjackAction[];
	playerBalance: number;
	currentBet: number;
}

export interface BlackjackAdvice {
	recommendedAction: BlackjackAction | null;
	reasoning: string;
	confidence: number;
	raw: string;
}

/**
 * Return the authoritative local advice for the current Blackjack state.
 * These are the existing lightweight strategy rules, kept intentionally
 * scoped rather than expanded into a complete strategy-table engine.
 */
export function getBlackjackStrategyAdvice(context: BlackjackAdviceContext): BlackjackAdvice {
	const { playerHand, dealerUpCard, availableActions } = context;
	const handValue = calculateHandValue(playerHand.cards);
	const dealerValue = ['J', 'Q', 'K'].includes(dealerUpCard.rank)
		? 10
		: dealerUpCard.rank === 'A'
			? 11
			: Number.parseInt(dealerUpCard.rank, 10);

	let action: BlackjackAction = 'stand';
	let reasoning = '';

	if (handValue.value <= 11) {
		action = 'hit';
		reasoning = `With ${handValue.value}, take a card because this total cannot bust on one hit.`;
	} else if (handValue.value >= 17) {
		action = 'stand';
		reasoning = `With ${handValue.value}, stand rather than take unnecessary bust risk.`;
	} else if (dealerValue >= 7) {
		action = 'hit';
		reasoning = `With ${handValue.value} against dealer ${dealerValue}, improve the hand against a strong up-card.`;
	} else {
		action = 'stand';
		reasoning = `With ${handValue.value} against dealer ${dealerValue}, let the dealer take the bust risk.`;
	}

	if (
		availableActions.includes('double-down') &&
		(handValue.value === 10 || handValue.value === 11)
	) {
		action = 'double-down';
		reasoning = `With ${handValue.value}, double down while the one-card upside is strong.`;
	}

	if (availableActions.includes('split') && playerHand.cards.length === 2) {
		const [first, second] = playerHand.cards;
		if (first.rank === second.rank && (first.rank === 'A' || first.rank === '8')) {
			action = 'split';
			reasoning = `Split ${first.rank}s according to the current basic-strategy rule.`;
		}
	}

	const legalActions = availableActions.filter((candidate) => candidate !== 'ask-ai');
	if (!legalActions.includes(action)) {
		action = legalActions.includes('hit')
			? 'hit'
			: legalActions.includes('stand')
				? 'stand'
				: (legalActions[0] ?? 'stand');
	}

	return {
		recommendedAction: legalActions.length > 0 ? action : null,
		reasoning: `${reasoning} (basic strategy)`,
		confidence: 1,
		raw: '',
	};
}

/**
 * Get deterministic advice and, when configured, ask a provider to explain
 * the move without allowing it to change the legal action.
 */
export async function getBlackjackAdvice(
	context: BlackjackAdviceContext,
	settings: AiSettings | null,
): Promise<BlackjackAdvice> {
	const deterministic = getBlackjackStrategyAdvice(context);
	if (!settings || !deterministic.recommendedAction) return deterministic;

	const result = await generateAiJson(settings, {
		system: 'Explain the already-selected Blackjack move. Do not choose a different move.',
		prompt: [
			`Move: ${deterministic.recommendedAction}`,
			`Base explanation: ${deterministic.reasoning}`,
			'Return {"reasoning":"one concise explanation"}.',
		].join('\n'),
		temperature: 0.3,
		maxOutputTokens: 120,
	});

	if (!result.ok) return deterministic;
	const reasoning = result.value.reasoning;
	return typeof reasoning === 'string' && reasoning.trim()
		? {
				...deterministic,
				reasoning: reasoning.trim(),
				raw: JSON.stringify(result.value),
			}
		: deterministic;
}
