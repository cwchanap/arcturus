import { afterEach, describe, expect, test } from 'bun:test';
import { getBaccaratAdvice } from './llmBaccaratStrategy';
import type { BaccaratAdviceContext } from './llmBaccaratStrategy';
import type { AiSettings } from '../ai';

const settings: AiSettings = {
	provider: 'openai',
	model: 'gpt-4o',
	apiKey: 'test-key',
};

const context: BaccaratAdviceContext = {
	roundHistory: [],
	currentBets: [],
	chipBalance: 1_000,
	shoeCardsRemaining: 312,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('getBaccaratAdvice', () => {
	test('uses the shared client and parses a banker recommendation', async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Banker has the lowest house edge.","suggestedBets":["banker"],"confidence":"high"}',
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);

		const result = await getBaccaratAdvice(context, settings);

		expect(result.suggestedBets).toContain('banker');
	});

	test('throws when the shared client cannot parse provider JSON', async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});

		await expect(getBaccaratAdvice(context, settings)).rejects.toThrow(
			'Provider returned no valid JSON object',
		);
	});

	test('filters invalid suggested bet values from a parsed provider response', async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Prefer the banker bet.","suggestedBets":["banker","invalid"],"confidence":"medium"}',
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);

		const result = await getBaccaratAdvice(context, settings);

		expect(result.suggestedBets).toEqual(['banker']);
	});

	test('keeps the recommendation identical across locales — only the explanation language changes', async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"Banker has the lowest house edge.","suggestedBets":["banker"],"confidence":"high"}',
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)) as unknown as typeof fetch;

		const jaResult = await getBaccaratAdvice({ ...context, locale: 'ja' }, settings);
		const enResult = await getBaccaratAdvice({ ...context, locale: 'en' }, settings);

		// The authoritative recommendation never changes with the locale.
		expect(jaResult.suggestedBets).toEqual(enResult.suggestedBets);
		expect(jaResult.confidence).toBe(enResult.confidence);
		// The locale only steers the prose language (the provider response).
		expect(jaResult.advice).toBe('Banker has the lowest house edge.');
	});

	test('passes the requested language into the provider prompt', async () => {
		let promptBody = '';
		globalThis.fetch = (async (_url, init) => {
			promptBody = String(init?.body);
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"advice":"バンカーが最良です。","suggestedBets":["banker"],"confidence":"high"}',
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as typeof fetch;

		await getBaccaratAdvice({ ...context, locale: 'ja' }, settings);

		expect(promptBody).toContain('Respond in Japanese.');
	});
});
