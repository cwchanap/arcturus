/**
 * LLM-based Baccarat Strategy Advisor
 * Provides AI-powered betting insights and pattern analysis
 */

import type { RoundOutcome, BetType } from './types';

export interface LLMSettings {
	provider: 'openai' | 'gemini';
	apiKey: string;
	model: string;
}

export interface BaccaratAdviceContext {
	roundHistory: RoundOutcome[];
	currentBets: Array<{ type: BetType; amount: number }>;
	chipBalance: number;
	shoeCardsRemaining: number;
	query?: string;
}

export interface BaccaratAdvice {
	advice: string;
	suggestedBets: BetType[];
	confidence: 'low' | 'medium' | 'high';
	raw: string;
}

const DEFAULT_TIMEOUT = 5000; // 5 seconds

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
	const { roundHistory, currentBets, chipBalance, shoeCardsRemaining, query } = context;

	const historyStr = formatHistory(roundHistory);
	const streakInfo = analyzeStreaks(roundHistory);
	const betsStr =
		currentBets.length > 0 ? currentBets.map((b) => `${b.type}: $${b.amount}`).join(', ') : 'None';

	const userQuery = query || 'What bet would you recommend for the next round?';

	return `Current Baccarat Session:

Recent History (newest first):
${historyStr}

Pattern Analysis: ${streakInfo}

Current State:
- Your Bets: ${betsStr}
- Chip Balance: $${chipBalance}
- Cards Remaining in Shoe: ${shoeCardsRemaining}

Player Question: ${userQuery}

Provide advice in this JSON format:
{"advice":"your concise advice","suggestedBets":["player"|"banker"|"tie"|"playerPair"|"bankerPair"],"confidence":"low|medium|high"}`;
}

/**
 * Call OpenAI API
 */
async function callOpenAI(
	systemPrompt: string,
	userPrompt: string,
	model: string,
	apiKey: string,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt },
				],
				temperature: 0.7,
				max_tokens: 300,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`OpenAI API error: ${response.status} - ${error}`);
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		return data.choices?.[0]?.message?.content || '';
	} catch (error) {
		clearTimeout(timeout);
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Request timed out');
		}
		throw error;
	}
}

/**
 * Call Gemini API
 */
async function callGemini(
	systemPrompt: string,
	userPrompt: string,
	model: string,
	apiKey: string,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					contents: [
						{
							parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
						},
					],
					generationConfig: {
						temperature: 0.7,
						maxOutputTokens: 300,
					},
				}),
				signal: controller.signal,
			},
		);

		clearTimeout(timeout);

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Gemini API error: ${response.status} - ${error}`);
		}

		const data = (await response.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
	} catch (error) {
		clearTimeout(timeout);
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Request timed out');
		}
		throw error;
	}
}

/**
 * Parse LLM response into structured advice
 */
function parseResponse(rawResponse: string): BaccaratAdvice {
	// Try to extract JSON from response
	const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return {
			advice: rawResponse.trim(),
			suggestedBets: ['banker'], // Default to lowest house edge
			confidence: 'low',
			raw: rawResponse,
		};
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		return {
			advice: parsed.advice || rawResponse.trim(),
			suggestedBets: Array.isArray(parsed.suggestedBets) ? parsed.suggestedBets : ['banker'],
			confidence: ['low', 'medium', 'high'].includes(parsed.confidence)
				? parsed.confidence
				: 'medium',
			raw: rawResponse,
		};
	} catch {
		return {
			advice: rawResponse.trim(),
			suggestedBets: ['banker'],
			confidence: 'low',
			raw: rawResponse,
		};
	}
}

/**
 * Get Baccarat advice from LLM
 */
export async function getBaccaratAdvice(
	context: BaccaratAdviceContext,
	settings: LLMSettings,
): Promise<BaccaratAdvice> {
	if (!settings.apiKey) {
		throw new Error('API key not configured');
	}

	const systemPrompt = buildSystemPrompt();
	const userPrompt = buildPrompt(context);

	let rawResponse: string;

	if (settings.provider === 'openai') {
		rawResponse = await callOpenAI(systemPrompt, userPrompt, settings.model, settings.apiKey);
	} else if (settings.provider === 'gemini') {
		rawResponse = await callGemini(systemPrompt, userPrompt, settings.model, settings.apiKey);
	} else {
		throw new Error(`Unsupported provider: ${settings.provider}`);
	}

	return parseResponse(rawResponse);
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
): BaccaratAdviceContext {
	return {
		roundHistory,
		currentBets,
		chipBalance,
		shoeCardsRemaining,
		query,
	};
}
