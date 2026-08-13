import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import { extractBalancedJsonObjects } from '../llm-response-parsing';
import type { AiGenerateRequest, AiResult, AiSettings } from './types';

export const AI_REQUEST_TIMEOUT_MS = 5_000;

type OpenAiPayload = {
	choices?: Array<{ message?: { content?: string } }>;
};

type GeminiPayload = {
	candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

type ProviderRequest = { url: string; init: RequestInit };

function buildProviderRequest(settings: AiSettings, request: AiGenerateRequest): ProviderRequest {
	const temperature = request.temperature ?? 0.3;
	const maxOutputTokens = request.maxOutputTokens ?? 200;

	if (settings.provider === 'openai') {
		return {
			url: 'https://api.openai.com/v1/chat/completions',
			init: {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${settings.apiKey}`,
				},
				body: JSON.stringify({
					model: settings.model,
					messages: [
						...(request.system ? [{ role: 'system', content: request.system }] : []),
						{ role: 'user', content: request.prompt },
					],
					temperature,
					max_tokens: maxOutputTokens,
				}),
			} satisfies RequestInit,
		};
	}

	return {
		url: `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`,
		init: {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-goog-api-key': settings.apiKey,
			},
			body: JSON.stringify({
				contents: [
					{
						role: 'user',
						parts: [
							{
								text: `${request.system ? `${request.system}\n\n` : ''}${request.prompt}`,
							},
						],
					},
				],
				generationConfig: { temperature, maxOutputTokens },
			}),
		} satisfies RequestInit,
	};
}

export async function generateAiText(
	settings: AiSettings,
	request: AiGenerateRequest,
): Promise<AiResult<string>> {
	const { url, init } = buildProviderRequest(settings, request);

	let response: Response;
	let data: OpenAiPayload | GeminiPayload;
	try {
		const result = await fetchJsonWithTimeout<OpenAiPayload | GeminiPayload>(
			url,
			init,
			request.timeoutMs ?? AI_REQUEST_TIMEOUT_MS,
		);
		response = result.response;
		data = result.data;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return { ok: false, code: 'timeout', message: 'AI request timed out' };
		}
		if (error instanceof SyntaxError) {
			return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON' };
		}
		return { ok: false, code: 'provider-error', message: 'AI request failed' };
	}

	if (!response.ok) {
		return {
			ok: false,
			code: 'provider-error',
			message: `Provider request failed (${response.status})`,
			status: response.status,
		};
	}

	const value =
		settings.provider === 'openai'
			? (data as OpenAiPayload).choices?.[0]?.message?.content
			: (data as GeminiPayload).candidates?.[0]?.content?.parts
					?.map((part) => part.text ?? '')
					.join('');

	return typeof value === 'string' && value.trim()
		? { ok: true, value: value.trim() }
		: { ok: false, code: 'invalid-response', message: 'Provider returned no text' };
}

export async function generateAiJson(
	settings: AiSettings,
	request: AiGenerateRequest,
): Promise<AiResult<Record<string, unknown>>> {
	const text = await generateAiText(settings, request);
	if (!text.ok) return text;

	for (const candidate of extractBalancedJsonObjects(text.value)) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return { ok: true, value: parsed as Record<string, unknown> };
			}
		} catch {
			// Try the next balanced object.
		}
	}

	return { ok: false, code: 'invalid-response', message: 'Provider returned no valid JSON object' };
}
