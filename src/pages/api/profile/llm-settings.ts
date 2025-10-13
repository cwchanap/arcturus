import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import {
	isValidModel,
	isValidProvider,
	getLlmSettings,
	upsertLlmSettings,
} from '../../../lib/llm-settings';

function jsonResponse(body: Record<string, unknown>, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		headers: {
			'content-type': 'application/json',
		},
		...init,
	});
}

async function getDb(locals: App.Locals) {
	let dbBinding = locals.runtime?.env?.DB ?? null;

	if (!dbBinding && import.meta.env.DEV) {
		try {
			const { getMockD1Database } = await import('../../../lib/mock-d1');
			dbBinding = await getMockD1Database();
		} catch (error) {
			console.error('Error creating mock D1 database:', error);
		}
	}

	return dbBinding ? createDb(dbBinding) : null;
}

function serializeSettings(settings: Awaited<ReturnType<typeof getLlmSettings>>) {
	return {
		provider: settings.provider,
		model: settings.model,
		openaiApiKey: settings.openaiApiKey,
		geminiApiKey: settings.geminiApiKey,
		hasOpenaiKey: Boolean(settings.openaiApiKey),
		hasGeminiKey: Boolean(settings.geminiApiKey),
		updatedAt: settings.updatedAt.toISOString(),
	};
}

export const GET: APIRoute = async ({ locals }) => {
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDb(locals);
	if (!db) {
		return jsonResponse({ error: 'Database unavailable' }, { status: 500 });
	}

	const settings = await getLlmSettings(db, session.user.id);

	return jsonResponse({
		settings: serializeSettings(settings),
	});
};

export const POST: APIRoute = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDb(locals);
	if (!db) {
		return jsonResponse({ error: 'Database unavailable' }, { status: 500 });
	}

	let payload: Record<string, unknown>;

	try {
		payload = (await request.json()) as Record<string, unknown>;
	} catch (error) {
		console.error('Invalid JSON payload for LLM settings:', error);
		return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
	}

	const provider = typeof payload.provider === 'string' ? payload.provider.toLowerCase() : '';
	const model = typeof payload.model === 'string' ? payload.model : '';
	const openaiApiKey =
		typeof payload.openaiApiKey === 'string' && payload.openaiApiKey.trim().length > 0
			? payload.openaiApiKey.trim()
			: null;
	const geminiApiKey =
		typeof payload.geminiApiKey === 'string' && payload.geminiApiKey.trim().length > 0
			? payload.geminiApiKey.trim()
			: null;

	if (!isValidProvider(provider)) {
		return jsonResponse({ error: 'Unsupported provider' }, { status: 400 });
	}

	if (!isValidModel(provider, model)) {
		return jsonResponse({ error: 'Unsupported model for provider' }, { status: 400 });
	}

	await upsertLlmSettings(db, session.user.id, {
		provider,
		model,
		openaiApiKey,
		geminiApiKey,
	});

	const updated = await getLlmSettings(db, session.user.id);

	return jsonResponse({
		settings: serializeSettings(updated),
	});
};
