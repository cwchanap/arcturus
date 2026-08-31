/**
 * Deterministic Blackjack strategy with an optional provider explanation.
 *
 * The local strategy always owns the recommended action. A configured AI
 * provider may only rewrite the explanation for that already-selected move.
 */

import { generateAiJson, type AiSettings } from '../ai';
import { formatWholeNumber } from '../formatting';
import { blackjackTranslator } from '../i18n/messages/blackjack';
import type { Locale } from '../i18n/locale';
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
 * scoped rather than expanded into a complete strategy-table engine. The
 * recommended action is language-neutral; only the explanation is localized.
 */
export function getBlackjackStrategyAdvice(
	context: BlackjackAdviceContext,
	locale: Locale = 'en',
): BlackjackAdvice {
	const { playerHand, dealerUpCard, availableActions } = context;
	const t = blackjackTranslator(locale);
	const actionName = (action: BlackjackAction): string => {
		switch (action) {
			case 'hit':
				return t('hit');
			case 'stand':
				return t('stand');
			case 'double-down':
				return t('doubleDown');
			case 'split':
				return t('split');
			default:
				return action;
		}
	};
	const handValue = calculateHandValue(playerHand.cards);
	const dealerValue = ['J', 'Q', 'K'].includes(dealerUpCard.rank)
		? 10
		: dealerUpCard.rank === 'A'
			? 11
			: Number.parseInt(dealerUpCard.rank, 10);
	const total = formatWholeNumber(handValue.value, locale);
	const dealer = formatWholeNumber(dealerValue, locale);

	let action: BlackjackAction = 'stand';
	let reasoning = '';

	if (handValue.value <= 11) {
		action = 'hit';
		reasoning = t('reasonLow', { total });
	} else if (handValue.value >= 17) {
		action = 'stand';
		reasoning = t('reasonHigh', { total });
	} else if (dealerValue >= 7) {
		action = 'hit';
		reasoning = t('reasonStrongDealer', { total, dealer });
	} else {
		action = 'stand';
		reasoning = t('reasonWeakDealer', { total, dealer });
	}

	if (
		availableActions.includes('double-down') &&
		(handValue.value === 10 || handValue.value === 11)
	) {
		action = 'double-down';
		reasoning = t('reasonDouble', { total });
	}

	if (availableActions.includes('split') && playerHand.cards.length === 2) {
		const [first, second] = playerHand.cards;
		if (first.rank === second.rank && (first.rank === 'A' || first.rank === '8')) {
			action = 'split';
			reasoning = t('reasonSplit', { rank: first.rank });
		}
	}

	const legalActions = availableActions.filter((candidate) => candidate !== 'ask-ai');
	if (legalActions.length > 0 && !legalActions.includes(action)) {
		action = legalActions.includes('hit')
			? 'hit'
			: legalActions.includes('stand')
				? 'stand'
				: (legalActions[0] ?? 'stand');
		reasoning = t('reasonFallback', { action: actionName(action) });
	}

	return {
		recommendedAction: legalActions.length > 0 ? action : null,
		reasoning: t('basicStrategyNote', { reasoning }),
		confidence: 1,
		raw: '',
	};
}

/**
 * Get deterministic advice and, when configured, ask a provider to explain
 * the move without allowing it to change the legal action. The provider
 * prompt requests the active locale so the explanation is written in the
 * player's language; the recommended action never depends on it.
 */
export async function getBlackjackAdvice(
	context: BlackjackAdviceContext,
	settings: AiSettings | null,
	locale: Locale = 'en',
): Promise<BlackjackAdvice> {
	const deterministic = getBlackjackStrategyAdvice(context, locale);
	if (!settings || !deterministic.recommendedAction) return deterministic;

	const result = await generateAiJson(settings, {
		system: 'Explain the already-selected Blackjack move. Do not choose a different move.',
		prompt: [
			`Move: ${deterministic.recommendedAction}`,
			`Base explanation: ${deterministic.reasoning}`,
			`Language: reply in the language of the locale tag "${locale}".`,
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
