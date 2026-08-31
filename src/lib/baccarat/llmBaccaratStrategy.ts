/**
 * LLM-based Baccarat Strategy Advisor
 * Provides AI-powered betting insights and pattern analysis
 */

import type { RoundOutcome, BetType } from './types';
import { generateAiJson, type AiSettings } from '../ai';
import type { Locale } from '../i18n/locale';

/** Language hint the prompt passes to the provider. */
const LOCALE_LANGUAGE: Record<Locale, string> = {
	en: 'English',
	'zh-Hant': 'Traditional Chinese',
	'zh-Hans': 'Simplified Chinese',
	ja: 'Japanese',
};

export interface BaccaratAdviceContext {
	roundHistory: RoundOutcome[];
	currentBets: Array<{ type: BetType; amount: number }>;
	chipBalance: number;
	shoeCardsRemaining: number;
	query?: string;
	/** Locale for the explanation prose; the recommendation stays language-neutral. */
	locale?: Locale;
}

export interface BaccaratAdvice {
	advice: string;
	suggestedBets: BetType[];
	confidence: 'low' | 'medium' | 'high';
	raw: string;
}

const VALID_BET_TYPES = new Set<BetType>(['player', 'banker', 'tie', 'playerPair', 'bankerPair']);

function isBetType(value: unknown): value is BetType {
	return typeof value === 'string' && VALID_BET_TYPES.has(value as BetType);
}

/**
 * Format history for display in prompt
 */
function formatHistory(history: RoundOutcome[]): string {
	if (history.length === 0) {
		return 'No rounds played yet';
	}

	return history
		.slice(0, 10) // Last 10 rounds
		.map((r, i) => {
			const pairInfo = [];
			if (r.playerPair) pairInfo.push('PP');
			if (r.bankerPair) pairInfo.push('BP');
			const pairs = pairInfo.length > 0 ? ` [${pairInfo.join(',')}]` : '';
			const natural = r.isNatural ? ' (N)' : '';
			return `${i + 1}. ${r.winner.toUpperCase()} (P:${r.playerValue} vs B:${r.bankerValue})${natural}${pairs}`;
		})
		.join('\n');
}

/**
 * Calculate streak information
 */
function analyzeStreaks(history: RoundOutcome[]): string {
	if (history.length < 2) return 'Not enough data for streak analysis';

	let currentStreak = 1;
	const currentWinner = history[0]?.winner;

	for (let i = 1; i < history.length && history[i].winner === currentWinner; i++) {
		currentStreak++;
	}

	const counts = history.reduce(
		(acc, h) => {
			acc[h.winner]++;
			return acc;
		},
		{ player: 0, banker: 0, tie: 0 },
	);

	return `Current ${currentWinner} streak: ${currentStreak}. Total: P=${counts.player}, B=${counts.banker}, T=${counts.tie}`;
}

/**
 * Build system prompt for Baccarat advice
 */
function buildSystemPrompt(): string {
	return `You are a knowledgeable Baccarat advisor. You understand Punto Banco rules and standard payouts:
- Player: 1:1
- Banker: 0.95:1 (5% commission)
- Tie: 8:1
- Player Pair: 11:1
- Banker Pair: 11:1

Important facts:
- Banker has a slight statistical edge (lowest house edge at ~1.06%)
- Tie bets have high house edge (~14.36%)
- Pair bets have ~11.25% house edge
- Past results don't affect future outcomes (independent events)

Provide practical, responsible betting advice. Be concise and clear.`;
}

/**
 * Build user prompt for Baccarat advice
 */
function buildPrompt(context: BaccaratAdviceContext): string {
	const { roundHistory, currentBets, chipBalance, shoeCardsRemaining, query, locale } = context;

	const historyStr = formatHistory(roundHistory);
	const streakInfo = analyzeStreaks(roundHistory);
	const betsStr =
		currentBets.length > 0
			? currentBets.map((b) => `${b.type}: ${b.amount} chips`).join(', ')
			: 'None';

	const userQuery = query || 'What bet would you recommend for the next round?';
	const language = locale ? LOCALE_LANGUAGE[locale] : 'English';

	return `Current Baccarat Session:

Recent History (newest first):
${historyStr}

Pattern Analysis: ${streakInfo}

Current State:
- Your Bets: ${betsStr}
- Chip Balance: ${chipBalance} chips
- Cards Remaining in Shoe: ${shoeCardsRemaining}

Player Question: ${userQuery}

Respond in ${language}. Provide advice in this JSON format:
{"advice":"your concise advice","suggestedBets":["player"|"banker"|"tie"|"playerPair"|"bankerPair"],"confidence":"low|medium|high"}`;
}

/**
 * Parse the shared client's structured response into Baccarat advice.
 */
function parseBaccaratPayload(payload: Record<string, unknown>): BaccaratAdvice {
	const raw = JSON.stringify(payload);
	const confidence = payload.confidence;
	const suggestedBets = Array.isArray(payload.suggestedBets)
		? payload.suggestedBets.filter(isBetType)
		: [];

	return {
		advice: typeof payload.advice === 'string' ? payload.advice : raw,
		suggestedBets: suggestedBets.length > 0 ? suggestedBets : ['banker'],
		confidence:
			confidence === 'low' || confidence === 'medium' || confidence === 'high'
				? confidence
				: 'medium',
		raw,
	};
}

/**
 * Get Baccarat advice from LLM
 */
export async function getBaccaratAdvice(
	context: BaccaratAdviceContext,
	settings: AiSettings,
): Promise<BaccaratAdvice> {
	if (!settings.apiKey) {
		throw new Error('API key not configured');
	}

	const result = await generateAiJson(settings, {
		system: buildSystemPrompt(),
		prompt: buildPrompt(context),
		temperature: 0.7,
		maxOutputTokens: 300,
	});
	if (!result.ok) throw new Error(result.message);
	return parseBaccaratPayload(result.value);
}

/**
 * Build context for advice request
 */
export function buildAdviceContext(
	roundHistory: RoundOutcome[],
	currentBets: Array<{ type: BetType; amount: number }>,
	chipBalance: number,
	shoeCardsRemaining: number,
	query?: string,
	locale?: Locale,
): BaccaratAdviceContext {
	return {
		roundHistory,
		currentBets,
		chipBalance,
		shoeCardsRemaining,
		query,
		locale,
	};
}
