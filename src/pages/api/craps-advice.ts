import type { APIRoute } from 'astro';
import { createDb } from '../../lib/db';
import { getLlmSettings } from '../../lib/llm-settings';
import { getCrapsAdvice } from '../../lib/craps/llmCrapsStrategy';
import type { CrapsAdviceContext, CrapsBet, GamePhase } from '../../lib/craps/types';
import { BET_LABELS, MAX_ROLL_HISTORY } from '../../lib/craps/constants';

const MAX_ACTIVE_BETS = 64;
const MAX_QUERY_LENGTH = 500;

function isValidActiveBet(value: unknown): value is CrapsAdviceContext['activeBets'][number] {
	if (!value || typeof value !== 'object') return false;
	const bet = value as {
		type?: unknown;
		amount?: unknown;
		point?: unknown;
		odds?: unknown;
	};

	if (typeof bet.type !== 'string' || !Object.hasOwn(BET_LABELS, bet.type)) return false;
	if (typeof bet.amount !== 'number' || !Number.isFinite(bet.amount) || bet.amount < 0)
		return false;
	if (
		bet.point !== null &&
		bet.point !== undefined &&
		(!Number.isInteger(bet.point) || ![4, 5, 6, 8, 9, 10].includes(bet.point as number))
	) {
		return false;
	}
	if (
		bet.odds !== undefined &&
		(typeof bet.odds !== 'number' || !Number.isFinite(bet.odds) || bet.odds < 0)
	) {
		return false;
	}

	return true;
}

function isValidRollHistoryEntry(
	value: unknown,
): value is CrapsAdviceContext['rollHistory'][number] {
	if (!value || typeof value !== 'object') return false;
	const roll = value as { die1?: unknown; die2?: unknown; total?: unknown };
	if (
		typeof roll.die1 !== 'number' ||
		typeof roll.die2 !== 'number' ||
		typeof roll.total !== 'number'
	) {
		return false;
	}
	if (
		!Number.isInteger(roll.die1) ||
		!Number.isInteger(roll.die2) ||
		!Number.isInteger(roll.total)
	) {
		return false;
	}
	if (roll.die1 < 1 || roll.die1 > 6 || roll.die2 < 1 || roll.die2 > 6) return false;
	if (roll.total < 2 || roll.total > 12 || roll.total !== roll.die1 + roll.die2) return false;

	return true;
}

function jsonResponse(body: Record<string, unknown>, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		headers: {
			'content-type': 'application/json',
		},
		...init,
	});
}

function isValidPhase(value: unknown): value is GamePhase {
	return value === 'come-out' || value === 'point';
}

/**
 * Aggregate multiple bets of the same type/point into a single bet object
 * to reduce payload size for the LLM API call.
 * Each click creates a separate bet object in the game state, but for advice purposes,
 * we only need to know the total amount for each bet type/point combination.
 */
function aggregateBets(
	activeBets: CrapsAdviceContext['activeBets'],
): CrapsAdviceContext['activeBets'] {
	const aggregated = new Map<string, CrapsBet>();

	for (const bet of activeBets) {
		// Create a unique key based on type, point, and odds
		const key = `${bet.type}-${bet.point ?? 'null'}-${bet.odds ?? 0}`;
		const existing = aggregated.get(key);

		if (existing) {
			existing.amount += bet.amount;
			existing.odds = (existing.odds ?? 0) + (bet.odds ?? 0);
		} else {
			aggregated.set(key, {
				id: `aggregated-${bet.type}-${bet.point ?? 'null'}-${bet.odds ?? 0}`,
				type: bet.type,
				amount: bet.amount,
				point: bet.point,
				odds: bet.odds,
			});
		}
	}

	return Array.from(aggregated.values());
}

function parseContext(payload: unknown): CrapsAdviceContext | null {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Partial<CrapsAdviceContext>;

	if (!isValidPhase(p.phase)) return null;
	if (p.point !== null && p.point !== undefined && ![4, 5, 6, 8, 9, 10].includes(p.point)) {
		return null;
	}
	if (typeof p.chipBalance !== 'number' || !Number.isFinite(p.chipBalance)) return null;
	if (!Array.isArray(p.activeBets) || !Array.isArray(p.rollHistory)) return null;
	if (!p.activeBets.every(isValidActiveBet) || !p.rollHistory.every(isValidRollHistoryEntry)) {
		return null;
	}
	if (p.rollHistory.length > MAX_ROLL_HISTORY) return null;

	// Aggregate bets before validating against MAX_ACTIVE_BETS
	const aggregatedBets = aggregateBets(p.activeBets);
	if (aggregatedBets.length > MAX_ACTIVE_BETS) return null;

	const query = typeof p.query === 'string' ? p.query.slice(0, MAX_QUERY_LENGTH) : undefined;

	return {
		phase: p.phase,
		point: p.point ?? null,
		chipBalance: p.chipBalance,
		activeBets: aggregatedBets,
		rollHistory: p.rollHistory,
		query,
	};
}

export const POST: APIRoute = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	const dbBinding = locals.runtime?.env?.DB ?? null;
	if (!dbBinding) {
		return jsonResponse({ error: 'Database unavailable' }, { status: 500 });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
	}

	const context = parseContext(payload);
	if (!context) {
		return jsonResponse({ error: 'Invalid advice context' }, { status: 400 });
	}

	try {
		const db = createDb(dbBinding);
		const settings = await getLlmSettings(db, session.user.id);
		const apiKey = settings.provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey;

		if (!apiKey) {
			return jsonResponse(
				{ error: 'No API key configured. Visit Profile to set up AI.' },
				{ status: 400 },
			);
		}

		const advice = await getCrapsAdvice(context, {
			provider: settings.provider,
			model: settings.model,
			apiKey,
		});

		return jsonResponse({ advice: advice.advice });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('Failed to get craps advice:', error);
		if (message.includes('timed out')) {
			return jsonResponse({ error: 'AI advisor timed out. Please try again.' }, { status: 504 });
		}
		if (message.includes('401') || message.toLowerCase().includes('api key')) {
			return jsonResponse(
				{ error: 'Invalid API key. Visit Profile to update your AI settings.' },
				{ status: 400 },
			);
		}
		if (message.includes('429')) {
			return jsonResponse(
				{ error: 'AI provider rate limit reached. Please wait a moment.' },
				{ status: 429 },
			);
		}
		return jsonResponse({ error: 'Failed to get advice. Please try again.' }, { status: 500 });
	}
};
