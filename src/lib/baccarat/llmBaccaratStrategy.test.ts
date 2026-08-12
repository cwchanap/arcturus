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
});
