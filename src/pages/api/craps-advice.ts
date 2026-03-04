import type { APIRoute } from 'astro';
import { createDb } from '../../lib/db';
import { getLlmSettings } from '../../lib/llm-settings';
import { getCrapsAdvice } from '../../lib/craps/llmCrapsStrategy';
import type { CrapsAdviceContext, GamePhase } from '../../lib/craps/types';

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

function parseContext(payload: unknown): CrapsAdviceContext | null {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Partial<CrapsAdviceContext>;

	if (!isValidPhase(p.phase)) return null;
	if (p.point !== null && p.point !== undefined && ![4, 5, 6, 8, 9, 10].includes(p.point)) {
		return null;
	}
	if (typeof p.chipBalance !== 'number' || !Number.isFinite(p.chipBalance)) return null;
	if (!Array.isArray(p.activeBets) || !Array.isArray(p.rollHistory)) return null;

	return {
		phase: p.phase,
		point: p.point ?? null,
		chipBalance: p.chipBalance,
		activeBets: p.activeBets,
		rollHistory: p.rollHistory,
		query: typeof p.query === 'string' ? p.query : undefined,
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
		console.error('Failed to get craps advice:', error);
		return jsonResponse({ error: 'Failed to get advice' }, { status: 500 });
	}
};
