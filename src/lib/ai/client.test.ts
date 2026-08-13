import { afterEach, expect, mock, test } from 'bun:test';
import { generateAiJson, generateAiText } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('OpenAI mapping extracts text', async () => {
	globalThis.fetch = mock(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as {
			model: string;
			messages: Array<{ content: string }>;
		};
		expect(body.model).toBe('gpt-4o');
		expect(body.messages.at(-1)?.content).toBe('Explain this move');
		return new Response(JSON.stringify({ choices: [{ message: { content: 'Stand here.' } }] }));
	}) as unknown as typeof fetch;

	expect(
		await generateAiText(
			{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
			{ prompt: 'Explain this move' },
		),
	).toEqual({ ok: true, value: 'Stand here.' });
});

test('Gemini mapping sends system and prompt text with provider defaults', async () => {
	globalThis.fetch = mock(async (url, init) => {
		const parsedUrl = new URL(String(url));
		expect(parsedUrl.pathname).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
		expect(parsedUrl.searchParams.get('key')).toBeNull();
		expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test');

		const body = JSON.parse(String(init?.body)) as {
			contents: Array<{ role: string; parts: Array<{ text: string }> }>;
			generationConfig: { temperature: number; maxOutputTokens: number };
		};
		expect(body.contents).toEqual([
			{ role: 'user', parts: [{ text: 'Be concise.\n\nExplain this move' }] },
		]);
		expect(body.generationConfig).toEqual({ temperature: 0.3, maxOutputTokens: 200 });

		return new Response(
			JSON.stringify({
				candidates: [{ content: { parts: [{ text: 'Stand' }, { text: ' here.' }] } }],
			}),
		);
	}) as unknown as typeof fetch;

	expect(
		await generateAiText(
			{ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' },
			{ system: 'Be concise.', prompt: 'Explain this move' },
		),
	).toEqual({ ok: true, value: 'Stand here.' });
});

test('generateAiJson tries balanced candidates instead of a greedy brace regex', async () => {
	globalThis.fetch = mock(
		async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'first {not valid} then {"reasoning":"Brace } inside string is safe"} trailing {"ignored":true}',
							},
						},
					],
				}),
			),
	) as unknown as typeof fetch;

	expect(
		await generateAiJson(
			{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
			{ prompt: 'Explain' },
		),
	).toEqual({ ok: true, value: { reasoning: 'Brace } inside string is safe' } });
});

test('parseable HTTP error preserves status', async () => {
	globalThis.fetch = mock(
		async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
	) as unknown as typeof fetch;

	expect(
		await generateAiText(
			{ provider: 'openai', model: 'gpt-4o', apiKey: 'bad-key' },
			{ prompt: 'x' },
		),
	).toEqual({
		ok: false,
		code: 'provider-error',
		message: 'Provider request failed (401)',
		status: 401,
	});
});

test('timeout override is passed through the shared request path', async () => {
	globalThis.fetch = mock(
		async (_url, init) =>
			await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('Aborted', 'AbortError')),
				);
			}),
	) as unknown as typeof fetch;

	const started = Date.now();
	const result = await generateAiText(
		{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
		{ prompt: 'x', timeoutMs: 1 },
	);
	expect(Date.now() - started).toBeLessThan(500);
	expect(result).toEqual({ ok: false, code: 'timeout', message: 'AI request timed out' });
});

test('uses the five-second timeout by default', async () => {
	const capturedTimeouts: number[] = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		capturedTimeouts.push(timeout ?? 0);
		return originalSetTimeout(handler, 0, ...args);
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
		originalClearTimeout(timer);
	}) as typeof clearTimeout;

	try {
		globalThis.fetch = mock(
			async (_url, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('Aborted', 'AbortError')),
					);
				}),
		) as unknown as typeof fetch;

		const result = await generateAiText(
			{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
			{ prompt: 'x' },
		);

		expect(capturedTimeouts).toContain(5_000);
		expect(result).toEqual({ ok: false, code: 'timeout', message: 'AI request timed out' });
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
});

test('normalizes malformed provider JSON as an invalid response', async () => {
	globalThis.fetch = mock(async () => new Response('{not-json')) as unknown as typeof fetch;

	expect(
		await generateAiText(
			{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
			{ prompt: 'x' },
		),
	).toEqual({
		ok: false,
		code: 'invalid-response',
		message: 'Provider returned invalid JSON',
	});
});

test('normalizes network failures as provider errors', async () => {
	globalThis.fetch = mock(async () => {
		throw new TypeError('Failed to fetch');
	}) as unknown as typeof fetch;

	expect(
		await generateAiText(
			{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
			{ prompt: 'x' },
		),
	).toEqual({ ok: false, code: 'provider-error', message: 'AI request failed' });
});
