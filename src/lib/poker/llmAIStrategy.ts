/**
 * LLM-based AI Strategy - Uses OpenAI/Gemini for poker decisions
 * Falls back to rule-based strategy on failure
 */

import type { AIDecision, AIPersonality, GameContext, Card } from './types';
import { getSuitSymbol } from '../card-format';
import { makeAIDecision as makeRuleBasedDecision, createAIConfig } from './aiStrategy';
import { DEFAULT_AI_DIFFICULTY, type AIDifficulty } from './aiDifficulty';
import { getHighestBet, getCallAmount } from './player';
import { generateAiJson, type AiSettings } from '../ai';

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
		const opponentCount = context.players.length - 1;
		return `${handStr}|${commStr}|${context.phase}|${highestBet}|${context.pot}|${context.position}|${opponentCount}`;
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
	return `${card.value}${getSuitSymbol(card.suit)}`;
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
 * Parse an already-structured shared-client response into AIDecision.
 */
function parseLLMPayload(
	payload: Record<string, unknown>,
	context: GameContext,
): AIDecision | null {
	const rawAction = payload.action;
	const action = typeof rawAction === 'string' ? rawAction.toLowerCase() : '';
	if (!['fold', 'check', 'call', 'raise'].includes(action)) return null;

	let amount = 0;
	if (action === 'raise') {
		const requested = typeof payload.amount === 'number' ? Math.round(payload.amount) : 0;
		const minRaise = Math.max(context.minimumBet, 10);
		amount = Math.max(minRaise, Math.min(requested, context.player.chips, 200));
	}

	return {
		action: action as AIDecision['action'],
		amount,
		confidence: 0.8,
		reasoning: `LLM decision: ${action}${action === 'raise' ? ` $${amount}` : ''}`,
	};
}

function ruleBasedFallback(
	context: GameContext,
	personality: AIPersonality,
	difficulty: AIDifficulty,
	reason: string,
): AIDecision {
	const aiConfig = createAIConfig(personality, difficulty);
	const decision = makeRuleBasedDecision(context, aiConfig);
	return { ...decision, reasoning: `${decision.reasoning} (${reason})` };
}

/**
 * Make AI decision using LLM
 */
export async function makeLLMDecision(
	context: GameContext,
	personality: AIPersonality,
	llmSettings: AiSettings | null,
	difficulty: AIDifficulty = DEFAULT_AI_DIFFICULTY,
): Promise<AIDecision> {
	// Check cache first
	const cached = decisionCache.get(context);
	if (cached) {
		return { ...cached, reasoning: `${cached.reasoning} (cached)` };
	}

	// If no LLM settings, fall back to rule-based
	if (!llmSettings) {
		return ruleBasedFallback(context, personality, difficulty, 'rule-based fallback');
	}

	try {
		const result = await generateAiJson(llmSettings, {
			system: 'You are an expert poker AI. Respond only with valid JSON.',
			prompt: buildLLMPrompt(context, personality),
			temperature: 0.7,
			maxOutputTokens: 100,
		});
		if (!result.ok) {
			return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
		}

		const decision = parseLLMPayload(result.value, context);
		if (decision) {
			// Cache successful decision
			decisionCache.set(context, decision);
			return decision;
		}

		// Parse failed, fall back to rule-based
		return ruleBasedFallback(context, personality, difficulty, 'LLM parse failed');
	} catch (error) {
		console.error('LLM decision failed:', error);
		// Fall back to rule-based on error
		return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
	}
}

/**
 * Clear decision cache (useful when starting new game)
 */
export function clearLLMCache(): void {
	decisionCache.clear();
}
