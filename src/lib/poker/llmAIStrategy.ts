/**
 * LLM-based AI Strategy - Uses OpenAI/Gemini for poker decisions
 * Falls back to rule-based strategy on failure
 */

import type { AIDecision, GameContext, Card, Suit } from './types';
import type { AIPersonality } from './aiStrategy';
import { makeAIDecision as makeRuleBasedDecision, createAIConfig } from './aiStrategy';
import { getHighestBet, getCallAmount } from './player';

export interface LLMSettings {
	provider: 'openai' | 'gemini';
	apiKey: string;
	model: string;
}

/**
 * Cache for LLM decisions to reduce API calls
 */
class DecisionCache {
	private cache = new Map<string, { decision: AIDecision; timestamp: number }>();
	private readonly TTL = 30000; // 30 seconds

	getCacheKey(context: GameContext): string {
		const sortedHand = [...context.player.hand].sort((a, b) =>
			a.value === b.value ? a.suit.localeCompare(b.suit) : a.value.localeCompare(b.value),
		);
		const handStr = sortedHand.map((c) => `${c.value}${c.suit[0]}`).join('');
		const commStr = context.communityCards.map((c) => `${c.value}${c.suit[0]}`).join('');
		const highestBet = getHighestBet(context.players);
		return `${handStr}|${commStr}|${context.phase}|${highestBet}|${context.pot}`;
	}

	get(context: GameContext): AIDecision | null {
		const key = this.getCacheKey(context);
		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.timestamp < this.TTL) {
			return cached.decision;
		}
		return null;
	}

	set(context: GameContext, decision: AIDecision): void {
		const key = this.getCacheKey(context);
		this.cache.set(key, { decision, timestamp: Date.now() });

		// Clean old entries
		if (this.cache.size > 100) {
			const now = Date.now();
			for (const [k, v] of this.cache.entries()) {
				if (now - v.timestamp >= this.TTL) {
					this.cache.delete(k);
				}
			}
		}
	}

	clear(): void {
		this.cache.clear();
	}
}

const decisionCache = new DecisionCache();

/**
 * Format card for LLM prompt
 */
function formatCard(card: Card): string {
	const suitSymbols: Record<Suit, string> = {
		hearts: '♥',
		diamonds: '♦',
		clubs: '♣',
		spades: '♠',
	};
	return `${card.value}${suitSymbols[card.suit]}`;
}

/**
 * Build LLM prompt for poker decision
 */
function buildLLMPrompt(context: GameContext, personality: AIPersonality): string {
	const { player, players, communityCards, pot, phase } = context;

	const handStr = player.hand.map(formatCard).join(', ');
	const commStr =
		communityCards.length > 0 ? communityCards.map(formatCard).join(', ') : 'None yet';
	const highestBet = getHighestBet(players);
	const callAmount = getCallAmount(player, highestBet);
	const activePlayers = players.filter((p) => !p.folded);

	// Personality description
	const personalityDesc =
		personality === 'tight-aggressive'
			? 'conservative and aggressive'
			: personality === 'loose-aggressive'
				? 'loose and aggressive'
				: personality === 'tight-passive'
					? 'conservative and cautious'
					: 'loose and passive';

	return `You are an expert Texas Hold'em poker AI with a ${personalityDesc} playing style.

Current Situation:
- Game Phase: ${phase.toUpperCase()}
- Your Hole Cards: ${handStr}
- Community Cards: ${commStr}
- Pot Size: $${pot}
- Your Chips: $${player.chips}
- Current Bet to Match: $${callAmount}
- Active Players: ${activePlayers.length}

Your Options:
${callAmount === 0 ? '- CHECK (bet nothing)' : ''}
${callAmount > 0 ? `- CALL $${callAmount} (match current bet)` : ''}
- FOLD (give up this hand)
- RAISE (increase the bet)

Respond with ONLY a JSON object in this exact format:
{"action":"fold|check|call|raise","amount":number}

If raising, "amount" should be the RAISE amount (not total bet), between $10 and $${Math.min(player.chips, 200)}.
If folding, checking, or calling, omit "amount" or set to 0.

Make your decision now:`;
}

/**
 * Call OpenAI API
 */
async function callOpenAI(prompt: string, model: string, apiKey: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

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
						content: 'You are an expert poker AI. Respond only with valid JSON.',
					},
					{ role: 'user', content: prompt },
				],
				temperature: 0.7,
				max_tokens: 100,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			throw new Error(`OpenAI API error: ${response.status}`);
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
 */
async function callGemini(prompt: string, model: string, apiKey: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					generationConfig: { temperature: 0.7, maxOutputTokens: 100 },
					contents: [
						{
							role: 'user',
							parts: [{ text: prompt }],
						},
					],
				}),
				signal: controller.signal,
			},
		);

		clearTimeout(timeout);

		if (!response.ok) {
			throw new Error(`Gemini API error: ${response.status}`);
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
 * Parse LLM response into AIDecision
 */
function parseLLMResponse(response: string, context: GameContext): AIDecision | null {
	try {
		// Extract JSON from response
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return null;
		}

		const parsed = JSON.parse(jsonMatch[0]);
		const action = parsed.action?.toLowerCase();

		if (!action || !['fold', 'check', 'call', 'raise'].includes(action)) {
			return null;
		}

		let amount = 0;
		if (action === 'raise') {
			amount = typeof parsed.amount === 'number' ? Math.round(parsed.amount) : 0;
			// Clamp raise amount to respect table minimum bet and max of player chips or 200
			const minRaise = Math.max(context.minimumBet, 10);
			amount = Math.max(minRaise, Math.min(amount, context.player.chips, 200));
		}

		return {
			action: action as 'fold' | 'check' | 'call' | 'raise',
			amount,
			confidence: 0.8,
			reasoning: `LLM decision: ${action}${action === 'raise' ? ` $${amount}` : ''}`,
		};
	} catch (error) {
		console.error('Failed to parse LLM response:', error);
		return null;
	}
}

/**
 * Make AI decision using LLM
 */
export async function makeLLMDecision(
	context: GameContext,
	personality: AIPersonality,
	llmSettings: LLMSettings | null,
): Promise<AIDecision> {
	// Check cache first
	const cached = decisionCache.get(context);
	if (cached) {
		return { ...cached, reasoning: `${cached.reasoning} (cached)` };
	}

	// If no LLM settings, fall back to rule-based
	if (!llmSettings) {
		const aiConfig = createAIConfig(personality);
		const decision = makeRuleBasedDecision(context, aiConfig);
		return { ...decision, reasoning: `${decision.reasoning} (rule-based fallback)` };
	}

	try {
		const prompt = buildLLMPrompt(context, personality);
		let response = '';

		if (llmSettings.provider === 'openai') {
			response = await callOpenAI(prompt, llmSettings.model, llmSettings.apiKey);
		} else {
			response = await callGemini(prompt, llmSettings.model, llmSettings.apiKey);
		}

		const decision = parseLLMResponse(response, context);
		if (decision) {
			// Cache successful decision
			decisionCache.set(context, decision);
			return decision;
		}

		// Parse failed, fall back to rule-based
		const aiConfig = createAIConfig(personality);
		const fallbackDecision = makeRuleBasedDecision(context, aiConfig);
		return { ...fallbackDecision, reasoning: `${fallbackDecision.reasoning} (LLM parse failed)` };
	} catch (error) {
		console.error('LLM decision failed:', error);
		// Fall back to rule-based on error
		const aiConfig = createAIConfig(personality);
		const fallbackDecision = makeRuleBasedDecision(context, aiConfig);
		return { ...fallbackDecision, reasoning: `${fallbackDecision.reasoning} (LLM error fallback)` };
	}
}

/**
 * Clear decision cache (useful when starting new game)
 */
export function clearLLMCache(): void {
	decisionCache.clear();
}
