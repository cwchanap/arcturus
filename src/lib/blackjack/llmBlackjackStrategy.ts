/**
 * LLM-based Blackjack Strategy Advisor
 * Provides AI-powered advice for Blackjack decisions using OpenAI or Gemini APIs
 */

import type { Card, Suit, BlackjackAction, Hand } from './types';
import { calculateHandValue } from './handEvaluator';
import { parseLLMResponse } from './llmResponseParsing';

export interface LLMSettings {
	provider: 'openai' | 'gemini';
	apiKey: string;
	model: string;
}

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

const DEFAULT_TIMEOUT = 5000; // 5 seconds

/**
 * Format card for display in prompt
 */
function formatCard(card: Card): string {
	const suitSymbols: Record<Suit, string> = {
		hearts: '♥',
		diamonds: '♦',
		clubs: '♣',
		spades: '♠',
	};
	return `${card.rank}${suitSymbols[card.suit]}`;
}

/**
 * Format hand for display in prompt
 */
function formatHand(cards: Card[]): string {
	return cards.map(formatCard).join(', ');
}

/**
 * Build LLM prompt for Blackjack advice
 */
function buildPrompt(context: BlackjackAdviceContext): string {
	const { playerHand, dealerUpCard, availableActions, playerBalance, currentBet } = context;

	const handValue = calculateHandValue(playerHand.cards);
	const handStr = formatHand(playerHand.cards);
	const dealerStr = formatCard(dealerUpCard);

	const actionsStr = availableActions
		.filter((a) => a !== 'ask-ai')
		.map((a) => a.toUpperCase())
		.join(', ');

	const softStr = handValue.isSoft ? ' (soft)' : '';

	return `You are an expert Blackjack strategist providing advice to a player.

Current Situation:
- Your Hand: ${handStr} (Total: ${handValue.value}${softStr})
- Dealer's Up Card: ${dealerStr}
- Your Bet: $${currentBet}
- Your Chip Balance: $${playerBalance}
- Available Actions: ${actionsStr}

Based on optimal Blackjack basic strategy, recommend the best action.

Respond with ONLY a JSON object in this exact format:
{"action":"hit|stand|double-down|split","reasoning":"brief explanation"}

Make your recommendation now:`;
}

/**
 * Call OpenAI API
 * @param systemMessage - Optional system message. Defaults to JSON-focused strategy advice.
 */
async function callOpenAI(
	prompt: string,
	model: string,
	apiKey: string,
	systemMessage?: string,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

	const defaultSystem =
		'You are an expert Blackjack strategist. Provide brief, actionable advice. Respond only with valid JSON.';

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{
						role: 'system',
						content: systemMessage ?? defaultSystem,
					},
					{ role: 'user', content: prompt },
				],
				temperature: 0.3,
				max_tokens: 150,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			const errorText = await response.text().catch(() => '');
			throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = (await response.json()) as any;
		return data?.choices?.[0]?.message?.content ?? '';
	} catch (error) {
		clearTimeout(timeout);
		throw error;
	}
}

/**
 * Call Gemini API
 * @param systemMessage - Optional system message. Defaults to JSON-focused strategy advice.
 */
async function callGemini(
	prompt: string,
	model: string,
	apiKey: string,
	systemMessage?: string,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

	const defaultSystem =
		'You are an expert Blackjack strategist. Provide brief, actionable advice. Respond only with valid JSON.';
	const systemPrefix = systemMessage ?? defaultSystem;

	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					generationConfig: { temperature: 0.3, maxOutputTokens: 150 },
					contents: [
						{
							role: 'user',
							parts: [
								{
									text: `${systemPrefix}\n\n${prompt}`,
								},
							],
						},
					],
				}),
				signal: controller.signal,
			},
		);

		clearTimeout(timeout);

		if (!response.ok) {
			const errorText = await response.text().catch(() => '');
			throw new Error(`Gemini API error: ${response.status} ${errorText}`);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = (await response.json()) as any;
		const text = data?.candidates?.[0]?.content?.parts
			?.map((part: { text?: string }) => part.text ?? '')
			.join('')
			.trim();
		return text || '';
	} catch (error) {
		clearTimeout(timeout);
		throw error;
	}
}

/**
 * Parse LLM response into BlackjackAdvice
 */
function parseResponse(
	response: string,
	availableActions: BlackjackAction[],
): BlackjackAdvice | null {
	try {
		// Extract JSON from response
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return null;
		}

		const parsed = JSON.parse(jsonMatch[0]);
		const action = parsed.action?.toLowerCase()?.replaceAll('_', '-');
		const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

		// Validate action is one of the available actions
		const validActions: BlackjackAction[] = ['hit', 'stand', 'double-down', 'split'];
		if (!action || !validActions.includes(action as BlackjackAction)) {
			return null;
		}

		// Check if action is actually available
		const recommendedAction = action as BlackjackAction;
		const isAvailable = availableActions.includes(recommendedAction);

		return {
			recommendedAction: isAvailable ? recommendedAction : null,
			reasoning: isAvailable
				? reasoning
				: `${reasoning} (Note: ${recommendedAction} is not available, consider alternatives)`,
			confidence: isAvailable ? 0.85 : 0.5,
			raw: response,
		};
	} catch (_error) {
		return null;
	}
}

/**
 * Get basic strategy fallback advice (no LLM)
 */
function getBasicStrategyAdvice(context: BlackjackAdviceContext): BlackjackAdvice {
	const { playerHand, dealerUpCard, availableActions } = context;
	const handValue = calculateHandValue(playerHand.cards);
	const dealerValue = ['J', 'Q', 'K'].includes(dealerUpCard.rank)
		? 10
		: dealerUpCard.rank === 'A'
			? 11
			: parseInt(dealerUpCard.rank, 10);

	let action: BlackjackAction = 'stand';
	let reasoning = '';

	// Very basic strategy
	if (handValue.value <= 11) {
		action = 'hit';
		reasoning = `With ${handValue.value}, always hit - no risk of busting.`;
	} else if (handValue.value >= 17) {
		action = 'stand';
		reasoning = `With ${handValue.value}, stand - risk of busting is too high.`;
	} else if (handValue.value >= 12 && handValue.value <= 16) {
		if (dealerValue >= 7) {
			action = 'hit';
			reasoning = `With ${handValue.value} against dealer ${dealerValue}, hit - dealer likely has strong hand.`;
		} else {
			action = 'stand';
			reasoning = `With ${handValue.value} against dealer ${dealerValue}, stand - dealer may bust.`;
		}
	}

	// Check for double-down opportunity
	if (
		availableActions.includes('double-down') &&
		(handValue.value === 10 || handValue.value === 11)
	) {
		action = 'double-down';
		reasoning = `With ${handValue.value}, double down - excellent opportunity to maximize winnings.`;
	}

	// Check for split opportunity (pairs)
	if (availableActions.includes('split') && playerHand.cards.length === 2) {
		const card1 = playerHand.cards[0].rank;
		const card2 = playerHand.cards[1].rank;
		if (card1 === card2) {
			// Always split Aces and 8s
			if (card1 === 'A' || card1 === '8') {
				action = 'split';
				reasoning = `Always split ${card1}s - basic strategy fundamental.`;
			}
		}
	}

	// Ensure action is available
	if (!availableActions.includes(action)) {
		action = availableActions.includes('hit') ? 'hit' : 'stand';
		reasoning += ' (adjusted to available action)';
	}

	return {
		recommendedAction: action,
		reasoning: `${reasoning} (basic strategy)`,
		confidence: 0.7,
		raw: '',
	};
}

/**
 * Get Blackjack advice from LLM
 */
export async function getBlackjackAdvice(
	context: BlackjackAdviceContext,
	llmSettings: LLMSettings | null,
): Promise<BlackjackAdvice> {
	// If no LLM settings, return basic strategy fallback
	if (!llmSettings || !llmSettings.apiKey) {
		return getBasicStrategyAdvice(context);
	}

	try {
		const prompt = buildPrompt(context);
		let response = '';

		if (llmSettings.provider === 'openai') {
			response = await callOpenAI(prompt, llmSettings.model, llmSettings.apiKey);
		} else {
			response = await callGemini(prompt, llmSettings.model, llmSettings.apiKey);
		}

		const advice = parseResponse(response, context.availableActions);
		if (advice) {
			return advice;
		}

		// Parse failed, fall back to basic strategy
		const fallback = getBasicStrategyAdvice(context);
		return {
			...fallback,
			reasoning: `${fallback.reasoning} (LLM response could not be parsed)`,
		};
	} catch (error) {
		// API error, fall back to basic strategy
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		const fallback = getBasicStrategyAdvice(context);
		return {
			...fallback,
			reasoning: `${fallback.reasoning} (LLM unavailable: ${errorMessage})`,
		};
	}
}

/**
 * Get round outcome commentary from LLM
 * @param playerHands - All player hands (supports split scenarios)
 * @param dealerHand - The dealer's hand
 * @param outcome - The overall round outcome
 * @param llmSettings - LLM configuration (null for default commentary)
 */
export async function getRoundCommentary(
	playerHands: Hand[],
	dealerHand: Hand,
	outcome: 'win' | 'loss' | 'push' | 'blackjack',
	llmSettings: LLMSettings | null,
): Promise<string> {
	// Default commentary without LLM
	const defaultComments: Record<string, string> = {
		win: 'Nice win! Your strategy paid off.',
		loss: "Tough break. The cards didn't fall your way this time.",
		push: 'A push - you keep your bet. Live to fight another hand!',
		blackjack: 'Blackjack! Nothing beats that natural 21!',
	};

	if (!llmSettings || !llmSettings.apiKey) {
		return defaultComments[outcome];
	}

	const dealerValue = calculateHandValue(dealerHand.cards);

	// Build hand summary for all player hands (supports split scenarios)
	const isSplit = playerHands.length > 1;
	let handsDescription: string;

	if (isSplit) {
		// For split hands, describe each hand
		const handDescriptions = playerHands.map((hand, i) => {
			const value = calculateHandValue(hand.cards);
			return `Hand ${i + 1}: ${formatHand(hand.cards)} (${value.value})`;
		});
		handsDescription = `Player split into ${playerHands.length} hands:\n${handDescriptions.join('\n')}`;
	} else {
		const playerValue = calculateHandValue(playerHands[0].cards);
		handsDescription = `Player's Hand: ${formatHand(playerHands[0].cards)} (${playerValue.value})`;
	}

	const prompt = `${handsDescription}
Dealer's Hand: ${formatHand(dealerHand.cards)} (${dealerValue.value})

Result: Player ${outcome.toUpperCase()}${isSplit ? ' overall' : ''}

Give a brief, entertaining one-liner comment (max 15 words). Be supportive but realistic.
Respond with ONLY the comment text, no quotes or JSON.`;

	// Use a plain-text system message for commentary (no JSON requirement)
	const commentarySystem =
		'You are a witty casino dealer commenting on Blackjack hands. Respond with only plain text, no JSON.';

	try {
		let response = '';

		if (llmSettings.provider === 'openai') {
			response = await callOpenAI(prompt, llmSettings.model, llmSettings.apiKey, commentarySystem);
		} else {
			response = await callGemini(prompt, llmSettings.model, llmSettings.apiKey, commentarySystem);
		}

		// Clean up response - remove quotes and any JSON artifacts if present
		let cleaned = response.trim().replace(/^["']|["']$/g, '');
		// Strip any JSON wrapper that might have slipped through
		if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
			try {
				const parsed = JSON.parse(cleaned);
				cleaned = parsed.comment || parsed.text || parsed.message || defaultComments[outcome];
			} catch {
				// Not valid JSON, use as-is
			}
		}
		return cleaned || defaultComments[outcome];
	} catch (_error) {
		return defaultComments[outcome];
	}
}
