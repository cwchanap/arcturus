import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { getLlmSettings } from '../../../lib/llm-settings';

function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'content-type': 'application/json',
			...init?.headers,
		},
	});
}

export const POST: APIRoute = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	const dbBinding = locals.runtime?.env?.DB ?? null;
	if (!dbBinding) {
		return jsonResponse({ error: 'Database not available' }, { status: 500 });
	}

	try {
		const payload: unknown = await request.json();

		// Type guard: ensure payload is an object with provider property
		if (
			!payload ||
			typeof payload !== 'object' ||
			!('provider' in payload) ||
			typeof payload.provider !== 'string'
		) {
			return jsonResponse({ error: 'Invalid request body' }, { status: 400 });
		}

		const provider = payload.provider;

		if (provider !== 'openai' && provider !== 'gemini') {
			return jsonResponse({ error: 'Invalid provider' }, { status: 400 });
		}

		const db = createDb(dbBinding);
		const settings = await getLlmSettings(db, session.user.id);

		const apiKey = provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey;

		if (!apiKey) {
			return jsonResponse({ error: 'No API key found' }, { status: 404 });
		}

		return jsonResponse({ apiKey });
	} catch (error) {
		console.error('Error revealing API key:', error);
		return jsonResponse({ error: 'Failed to retrieve API key' }, { status: 500 });
	}
};
