import { afterEach, describe, expect, test } from 'bun:test';
import { getCrapsAdvice, aggregateBets } from './llmCrapsStrategy';
import type { AiSettings } from '../ai';
import type { CrapsAdviceContext } from './types';

const settings: AiSettings = {
	provider: 'openai',
	model: 'gpt-4o',
	apiKey: 'test-key',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('aggregateBets', () => {
	test('aggregates same-type bets at the same point and sums odds', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'come', amount: 100, point: 6, odds: 400 },
		]);

		expect(result).toEqual([
			{ id: 'aggregated-come-6', type: 'come', amount: 200, point: 6, odds: 600 },
		]);
	});

	test('keeps same-type bets at different points separate', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'come', amount: 100, point: 8, odds: 100 },
		]);

		expect(result).toHaveLength(2);
		expect(result.map((bet) => bet.point)).toEqual([6, 8]);
	});

	test('keeps different bet types at the same point separate', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'dontCome', amount: 100, point: 6, odds: 200 },
		]);

		expect(result).toHaveLength(2);
		expect(result.map((bet) => bet.type)).toEqual(['come', 'dontCome']);
	});

	test('aggregates same-type bets without odds', () => {
		const result = aggregateBets([
			{ id: '1', type: 'passLine', amount: 50 },
			{ id: '2', type: 'passLine', amount: 75 },
		]);

		expect(result).toEqual([
			{ id: 'aggregated-passLine-null', type: 'passLine', amount: 125, odds: 0 },
		]);
	});
});

describe('getCrapsAdvice', () => {
	const baseContext: CrapsAdviceContext = {
		phase: 'point',
		point: 6,
		chipBalance: 1200,
		activeBets: [
			{ id: 'b1', type: 'passLine', amount: 25 },
			{ id: 'b2', type: 'come', amount: 10, point: 6, odds: 20 },
			{ id: 'b3', type: 'come', amount: 15, point: 6, odds: 30 },
		],
		rollHistory: [{ die1: 3, die2: 3, total: 6 }],
		query: 'Should I take odds now?',
	};

	test('uses the shared client and parses Craps advice', async () => {
		globalThis.fetch = async (input, init) => {
			expect(new URL(String(input)).pathname).toBe('/v1/chat/completions');
			const body = JSON.parse(String(init?.body)) as {
				model: string;
				messages: Array<{ role: string; content: string }>;
			};
			expect(body.model).toBe('gpt-4o');
			expect(body.messages[1].content).toContain('passLine: 25 chips');
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Stay on the pass line and press odds.","suggestedBets":["passLine","place6"],"confidence":"high"}',
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		};

		const result = await getCrapsAdvice(
			{
				phase: 'come-out',
				point: null,
				chipBalance: 1000,
				activeBets: [{ id: 'bet-1', type: 'passLine', amount: 25 }],
				rollHistory: [{ die1: 3, die2: 4, total: 7 }],
			},
			settings,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.advice).toBe('Stay on the pass line and press odds.');
			expect(result.value.suggestedBets).toEqual(['passLine', 'place6']);
			expect(result.value.confidence).toBe('high');
		}
	});

	test('normalizes duplicate bets before building the provider prompt', async () => {
		globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as {
				messages: Array<{ content: string }>;
			};
			expect(body.messages[1].content).toContain('come: 25 chips @6 +odds:50 chips');
			expect(body.messages[1].content).not.toContain('come: 10 chips @6 +odds:20 chips');
			expect(body.messages[1].content).not.toContain('come: 15 chips @6 +odds:30 chips');
			return new Response(
				JSON.stringify({ choices: [{ message: { content: '{"advice":"Keep it steady."}' } }] }),
			);
		};

		const result = await getCrapsAdvice(baseContext, settings);

		expect(result).toMatchObject({ ok: true });
	});

	test('preserves parseable provider status for page-level UX', async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: 'bad key' }), { status: 401 });

		expect(await getCrapsAdvice(baseContext, settings)).toEqual({
			ok: false,
			code: 'provider-error',
			message: 'Provider request failed (401)',
			status: 401,
		});
	});

	test('requests the locale language in the prompt but keeps the recommendation neutral', async () => {
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				messages: Array<{ content: string }>;
			};
			expect(body.messages[1].content).toContain('Respond in Japanese');
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Stay on the pass line and press odds.","suggestedBets":["passLine","place6"],"confidence":"high"}',
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as typeof fetch;

		const result = await getCrapsAdvice({ ...baseContext, locale: 'ja' }, settings);

		expect(result.ok).toBe(true);
		if (result.ok) {
			// The authoritative recommendation is locale-independent; only the
			// explanation prose is requested in the player's language.
			expect(result.value.suggestedBets).toEqual(['passLine', 'place6']);
			expect(result.value.confidence).toBe('high');
		}
	});

	test('uses the Craps eight-second provider budget', async () => {
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
			globalThis.fetch = async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('Aborted', 'AbortError')),
					);
				});

			const result = await getCrapsAdvice(baseContext, settings);

			expect(capturedTimeouts).toContain(8_000);
			expect(result).toEqual({ ok: false, code: 'timeout', message: 'AI request timed out' });
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	test('keeps Craps response defaults for missing or invalid fields', async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Take single odds.","suggestedBets":"passLine","confidence":"extreme"}',
							},
						},
					],
				}),
			);

		const result = await getCrapsAdvice(baseContext, settings);

		expect(result).toMatchObject({
			ok: true,
			value: {
				advice: 'Take single odds.',
				suggestedBets: ['passLine'],
				confidence: 'medium',
			},
		});
	});

	test('filters mixed suggested bets to known Craps bet types', async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Keep the line working.","suggestedBets":["passLine","not-a-bet","place6",42,null]}',
							},
						},
					],
				}),
			);

		const result = await getCrapsAdvice(baseContext, settings);

		expect(result).toMatchObject({
			ok: true,
			value: { suggestedBets: ['passLine', 'place6'] },
		});
	});

	test('falls back to pass line when no suggested bets are valid', async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: '{"advice":"Keep it simple.","suggestedBets":["not-a-bet",{},null]}',
							},
						},
					],
				}),
			);

		const result = await getCrapsAdvice(baseContext, settings);

		expect(result).toMatchObject({
			ok: true,
			value: { suggestedBets: ['passLine'] },
		});
	});
});
