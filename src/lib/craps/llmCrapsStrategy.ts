/**
 * LLM-powered Craps strategy advisor
 * Provides colorful commentary and betting suggestions based on game state
 */

import { generateAiJson, type AiResult, type AiSettings } from '../ai';
import type { CrapsAdvice, CrapsAdviceContext, BetType, CrapsBet, DiceRoll } from './types';

/**
 * Aggregate repeated bets into one entry for the provider prompt.
 * Each click creates a separate bet object in game state, but advice only
 * needs the total amount for each type/point combination.
 */
export function aggregateBets(
	activeBets: CrapsAdviceContext['activeBets'],
): CrapsAdviceContext['activeBets'] {
	const aggregated = new Map<string, CrapsBet>();

	for (const bet of activeBets) {
		const key = `${bet.type}-${bet.point ?? 'null'}`;
		const existing = aggregated.get(key);

		if (existing) {
			existing.amount += bet.amount;
			existing.odds = (existing.odds ?? 0) + (bet.odds ?? 0);
		} else {
			aggregated.set(key, {
				id: `aggregated-${bet.type}-${bet.point ?? 'null'}`,
				type: bet.type,
				amount: bet.amount,
				point: bet.point,
				odds: bet.odds,
			});
		}
	}

	return Array.from(aggregated.values());
}

function formatRollHistory(history: DiceRoll[]): string {
	if (history.length === 0) return 'No rolls yet';
	return history
		.slice(0, 8)
		.map((r) => `${r.total}(${r.die1}+${r.die2})${r.die1 === r.die2 ? '*' : ''}`)
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

function parsePayload(payload: Record<string, unknown>): CrapsAdvice {
	const raw = JSON.stringify(payload);
	const confidence = payload.confidence;

	return {
		advice: typeof payload.advice === 'string' ? payload.advice : raw,
		suggestedBets: Array.isArray(payload.suggestedBets)
			? (payload.suggestedBets as BetType[])
			: ['passLine'],
		confidence:
			confidence === 'low' || confidence === 'medium' || confidence === 'high'
				? confidence
				: 'medium',
		raw,
	};
}

export async function getCrapsAdvice(
	ctx: CrapsAdviceContext,
	settings: AiSettings,
): Promise<AiResult<CrapsAdvice>> {
	const normalized = { ...ctx, activeBets: aggregateBets(ctx.activeBets) };
	const result = await generateAiJson(settings, {
		system: buildSystemPrompt(),
		prompt: buildPrompt(normalized),
		temperature: 0.8,
		maxOutputTokens: 250,
		timeoutMs: 8_000,
	});
	if (!result.ok) return result;
	return { ok: true, value: parsePayload(result.value) };
}
