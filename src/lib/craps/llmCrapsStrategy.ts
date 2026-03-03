/**
 * LLM-powered Craps strategy advisor
 * Provides colorful commentary and betting suggestions based on game state
 */

import type { CrapsAdvice, CrapsAdviceContext, BetType, DiceRoll } from './types';

export interface LLMSettings {
	provider: 'openai' | 'gemini';
	apiKey: string;
	model: string;
}

const DEFAULT_TIMEOUT = 8000;

function formatRollHistory(history: DiceRoll[]): string {
	if (history.length === 0) return 'No rolls yet';
	return history
		.slice(0, 8)
		.map((r) => `${r.total}(${r.die1}+${r.die2})${r.isHard ? '*' : ''}`)
		.join(', ');
}

function buildSystemPrompt(): string {
	return `You are a lively, experienced craps dealer and advisor at a Vegas casino. You know craps rules and strategy inside out.

Key craps facts:
- Pass Line (1:1) has 1.41% house edge — one of the best bets
- Don't Pass (1:1) has 1.36% house edge — slightly better
- Free Odds behind Pass/Don't Pass have ZERO house edge — always take them
- Place 6 & 8 (7:6) are the best place bets at 1.52% house edge
- Place 5 & 9 (7:5): 4% edge — reasonable
- Place 4 & 10 (9:5): 6.67% — high edge, avoid
- Field bet: 5.56% edge — avoid for consistent play
- Hardways: 9-11% edge — sucker bets but exciting
- Proposition bets (any7, craps, yo): 11-16% edge — avoid

Strategy advice:
- Conservative: Pass Line + max odds, maybe Place 6 and 8
- Moderate: Add Come bets with odds to cover more numbers
- Aggressive: Multiple place bets across the board

Be enthusiastic, use craps lingo ("yo-eleven!", "fighter on 5", "all day on the hard eight"), keep advice concise (2-3 sentences max).`;
}

function buildPrompt(ctx: CrapsAdviceContext): string {
	const phaseStr =
		ctx.phase === 'come-out'
			? 'Come-Out Roll (no point yet)'
			: `Point Phase — Point is ${ctx.point}`;

	const betsStr =
		ctx.activeBets.length > 0
			? ctx.activeBets
					.map((b) => {
						const odds = b.odds ? ` +odds:$${b.odds}` : '';
						const pt = b.point ? ` @${b.point}` : '';
						return `${b.type}:$${b.amount}${pt}${odds}`;
					})
					.join(', ')
			: 'None';

	const query = ctx.query ?? 'What should I do next?';

	return `Craps Session:
Phase: ${phaseStr}
Balance: $${ctx.chipBalance}
Active bets: ${betsStr}
Recent rolls: ${formatRollHistory(ctx.rollHistory)}

Player asks: ${query}

Reply in JSON:
{"advice":"<2-3 sentences>","suggestedBets":["passLine"|"come"|"place6"|"place8"|...],"confidence":"low|medium|high"}`;
}

async function callOpenAI(
	system: string,
	user: string,
	model: string,
	apiKey: string,
): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
	try {
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				temperature: 0.8,
				max_tokens: 250,
			}),
			signal: ctrl.signal,
		});
		clearTimeout(timer);
		if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
		const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
		return data.choices?.[0]?.message?.content ?? '';
	} catch (e) {
		clearTimeout(timer);
		if (e instanceof Error && e.name === 'AbortError') throw new Error('Request timed out');
		throw e;
	}
}

async function callGemini(
	system: string,
	user: string,
	model: string,
	apiKey: string,
): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: `${system}\n\n${user}` }] }],
					generationConfig: { temperature: 0.8, maxOutputTokens: 250 },
				}),
				signal: ctrl.signal,
			},
		);
		clearTimeout(timer);
		if (!res.ok) throw new Error(`Gemini error ${res.status}`);
		const data = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
	} catch (e) {
		clearTimeout(timer);
		if (e instanceof Error && e.name === 'AbortError') throw new Error('Request timed out');
		throw e;
	}
}

function parseResponse(raw: string): CrapsAdvice {
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return { advice: raw.trim(), suggestedBets: ['passLine'], confidence: 'low', raw };
	}
	try {
		const p = JSON.parse(jsonMatch[0]) as {
			advice?: string;
			suggestedBets?: BetType[];
			confidence?: string;
		};
		return {
			advice: p.advice ?? raw.trim(),
			suggestedBets: Array.isArray(p.suggestedBets) ? p.suggestedBets : ['passLine'],
			confidence: (['low', 'medium', 'high'] as const).includes(p.confidence as 'low')
				? (p.confidence as 'low' | 'medium' | 'high')
				: 'medium',
			raw,
		};
	} catch {
		return { advice: raw.trim(), suggestedBets: ['passLine'], confidence: 'low', raw };
	}
}

export async function getCrapsAdvice(
	ctx: CrapsAdviceContext,
	settings: LLMSettings,
): Promise<CrapsAdvice> {
	if (!settings.apiKey) throw new Error('API key not configured');

	const system = buildSystemPrompt();
	const user = buildPrompt(ctx);

	let raw: string;
	if (settings.provider === 'openai') {
		raw = await callOpenAI(system, user, settings.model, settings.apiKey);
	} else if (settings.provider === 'gemini') {
		raw = await callGemini(system, user, settings.model, settings.apiKey);
	} else {
		throw new Error(`Unsupported provider: ${settings.provider}`);
	}

	return parseResponse(raw);
}
