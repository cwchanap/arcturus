import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { aggregateBets, createPostHandler } from '../../pages/api/craps-advice';
import { getCrapsAdvice } from './llmCrapsStrategy';
import type { CrapsAdviceContext } from './types';

function createValidAdvicePayload(overrides: Record<string, unknown> = {}) {
	return {
		phase: 'come-out',
		point: null,
		chipBalance: 1000,
		activeBets: [{ id: 'bet-1', type: 'passLine', amount: 25 }],
		rollHistory: [{ die1: 3, die2: 4, total: 7 }],
		query: 'What should I do next?',
		...overrides,
	};
}

function createLocals({
	withSession = true,
	withDb = true,
}: {
	withSession?: boolean;
	withDb?: boolean;
} = {}) {
	return {
		session: withSession ? { user: { id: 'user-1' } } : null,
		runtime: withDb ? { env: { DB: { binding: true } } } : { env: {} },
	};
}

async function readJson(response: Response) {
	return JSON.parse(await response.text());
}

describe('aggregateBets', () => {
	test('aggregates Come bets at the same point with different odds into one entry', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'come', amount: 100, point: 6, odds: 400 },
		]);

		expect(result).toHaveLength(1);
		expect(result[0].amount).toBe(200);
		expect(result[0].odds).toBe(600);
	});

	test('keeps distinct bets at different points separate', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'come', amount: 100, point: 8, odds: 100 },
		]);

		expect(result).toHaveLength(2);
	});

	test('keeps distinct bet types separate even at the same point', () => {
		const result = aggregateBets([
			{ id: '1', type: 'come', amount: 100, point: 6, odds: 200 },
			{ id: '2', type: 'dontCome', amount: 100, point: 6, odds: 200 },
		]);

		expect(result).toHaveLength(2);
	});

	test('aggregates bets with no odds', () => {
		const result = aggregateBets([
			{ id: '1', type: 'passLine', amount: 50 },
			{ id: '2', type: 'passLine', amount: 75 },
		]);

		expect(result).toHaveLength(1);
		expect(result[0].amount).toBe(125);
	});
});

describe('craps advice API route', () => {
	let settingsResult: {
		provider: 'openai' | 'gemini';
		model: string;
		openaiApiKey: string | null;
		geminiApiKey: string | null;
		createdAt: Date;
		updatedAt: Date;
	} = {
		provider: 'openai',
		model: 'gpt-4o',
		openaiApiKey: 'openai-key',
		geminiApiKey: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	let adviceResult = {
		advice: 'Take odds behind the line.',
		suggestedBets: ['passLine'] as const,
		confidence: 'high' as const,
		raw: '{"advice":"Take odds behind the line."}',
	};
	const createDbCalls: unknown[] = [];
	const getSettingsCalls: unknown[][] = [];
	const getAdviceCalls: unknown[][] = [];

	const createDbImpl = (dbBinding: unknown) => {
		createDbCalls.push(dbBinding);
		return { db: true };
	};
	const getLlmSettingsImpl = async (...args: unknown[]) => {
		getSettingsCalls.push(args);
		return settingsResult;
	};
	let adviceImpl = async (...args: unknown[]) => {
		getAdviceCalls.push(args);
		return adviceResult;
	};

	function resetRouteMocks() {
		createDbCalls.length = 0;
		getSettingsCalls.length = 0;
		getAdviceCalls.length = 0;
		settingsResult = {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'openai-key',
			geminiApiKey: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		};
		adviceResult = {
			advice: 'Take odds behind the line.',
			suggestedBets: ['passLine'],
			confidence: 'high',
			raw: '{"advice":"Take odds behind the line."}',
		};
		adviceImpl = async (...args: unknown[]) => {
			getAdviceCalls.push(args);
			return adviceResult;
		};
	}

	test('rejects unauthorized requests', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const response = await POST({
			locals: createLocals({ withSession: false }),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(401);
		expect(body.error).toBe('Unauthorized');
	});

	test('rejects when DB binding is unavailable', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const response = await POST({
			locals: createLocals({ withDb: false }),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toBe('Database unavailable');
	});

	test('rejects malformed JSON request body', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: '{"phase":"come-out"',
				headers: { 'content-type': 'application/json' },
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('Invalid JSON payload');
	});

	test('rejects invalid context payload', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload({ phase: 'invalid-phase' })),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('Invalid advice context');
	});

	test('rejects invalid roll history entries and oversized roll history', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const invalidRollResponse = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(
					createValidAdvicePayload({
						rollHistory: [{ die1: 6, die2: 6, total: 11 }],
					}),
				),
			}),
		} as any);
		const invalidRollBody = await readJson(invalidRollResponse);
		expect(invalidRollResponse.status).toBe(400);
		expect(invalidRollBody.error).toBe('Invalid advice context');

		const tooLongHistory = Array.from({ length: 31 }, () => ({ die1: 1, die2: 1, total: 2 }));
		const oversizedHistoryResponse = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload({ rollHistory: tooLongHistory })),
			}),
		} as any);
		const oversizedHistoryBody = await readJson(oversizedHistoryResponse);
		expect(oversizedHistoryResponse.status).toBe(400);
		expect(oversizedHistoryBody.error).toBe('Invalid advice context');
	});

	test('aggregates duplicate bets and truncates query before calling strategy', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const longQuery = 'q'.repeat(650);
		const manyDuplicateBets = Array.from({ length: 80 }, (_unused, index) => ({
			id: `bet-${index}`,
			type: 'passLine',
			amount: 5,
		}));
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(
					createValidAdvicePayload({
						activeBets: manyDuplicateBets,
						query: longQuery,
					}),
				),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.advice).toBe('Take odds behind the line.');
		expect(getAdviceCalls.length).toBe(1);
		const [context] = getAdviceCalls[0] as [CrapsAdviceContext, unknown];
		expect(context.activeBets).toHaveLength(1);
		expect(context.activeBets[0].amount).toBe(400);
		expect(context.query?.length).toBe(500);
		expect(createDbCalls.length).toBe(1);
		expect(getSettingsCalls.length).toBe(1);
	});

	test('rejects when aggregated active bets exceed limit', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const types = [
			'passLine',
			'dontPass',
			'come',
			'dontCome',
			'place4',
			'place5',
			'place6',
			'place8',
			'place9',
			'place10',
		];
		const points = [null, 4, 5, 6, 8, 9, 10];
		const lotsOfDistinctBets = types
			.flatMap((type) => points.map((point) => ({ type, point })))
			.slice(0, 65)
			.map((bet, index) => ({
				id: `bet-${index}`,
				type: bet.type,
				amount: 5,
				point: bet.point,
			}));
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload({ activeBets: lotsOfDistinctBets })),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('Invalid advice context');
	});

	test('returns missing API key error for configured provider', async () => {
		resetRouteMocks();
		settingsResult = {
			...settingsResult,
			provider: 'gemini',
			geminiApiKey: null,
		};
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toContain('No API key configured');
		expect(getAdviceCalls.length).toBe(0);
	});

	test('maps timeout and provider errors to expected status codes', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});

		adviceImpl = async (...args: unknown[]) => {
			getAdviceCalls.push(args);
			throw new Error('request timed out');
		};
		const timeoutResponse = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const timeoutBody = await readJson(timeoutResponse);
		expect(timeoutResponse.status).toBe(504);
		expect(timeoutBody.error).toContain('timed out');

		adviceImpl = async (...args: unknown[]) => {
			getAdviceCalls.push(args);
			throw new Error('OpenAI error 401');
		};
		const authResponse = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const authBody = await readJson(authResponse);
		expect(authResponse.status).toBe(400);
		expect(authBody.error).toContain('Invalid API key');

		adviceImpl = async (...args: unknown[]) => {
			getAdviceCalls.push(args);
			throw new Error('provider 429');
		};
		const limitResponse = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const limitBody = await readJson(limitResponse);
		expect(limitResponse.status).toBe(429);
		expect(limitBody.error).toContain('rate limit');
	});

	test('maps unknown errors to generic 500 response', async () => {
		resetRouteMocks();
		const POST = createPostHandler({
			createDb: createDbImpl as any,
			getLlmSettings: getLlmSettingsImpl as any,
			getCrapsAdvice: ((...args: unknown[]) => adviceImpl(...args)) as any,
		});
		adviceImpl = async (...args: unknown[]) => {
			getAdviceCalls.push(args);
			throw 'unexpected-failure';
		};
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(createValidAdvicePayload()),
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toContain('Failed to get advice');
	});
});

describe('llm craps strategy', () => {
	const baseContext: CrapsAdviceContext = {
		phase: 'point',
		point: 6,
		chipBalance: 1200,
		activeBets: [
			{ id: 'b1', type: 'passLine', amount: 25 },
			{ id: 'b2', type: 'come', amount: 10, point: 6, odds: 20 },
		],
		rollHistory: [
			{ die1: 1, die2: 1, total: 2 },
			{ die1: 2, die2: 3, total: 5 },
			{ die1: 3, die2: 3, total: 6 },
			{ die1: 4, die2: 3, total: 7 },
			{ die1: 2, die2: 6, total: 8 },
			{ die1: 5, die2: 4, total: 9 },
			{ die1: 6, die2: 4, total: 10 },
			{ die1: 5, die2: 6, total: 11 },
			{ die1: 6, die2: 6, total: 12 },
		],
		query: 'Should I take odds now?',
	};
	let originalFetch: typeof fetch;
	let originalConsoleError: typeof console.error;

	function setMockFetch(fn: (...args: unknown[]) => Promise<Response>) {
		globalThis.fetch = fn as unknown as typeof fetch;
	}

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalConsoleError = console.error;
		console.error = () => {};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
	});

	test('throws when API key is missing', async () => {
		await expect(
			getCrapsAdvice(baseContext, {
				provider: 'openai',
				model: 'gpt-4o',
				apiKey: '',
			}),
		).rejects.toThrow('API key not configured');
	});

	test('calls OpenAI and parses valid JSON advice', async () => {
		setMockFetch(async (input: unknown, init?: unknown) => {
			expect(String(input)).toContain('/v1/chat/completions');
			const requestInit = init as RequestInit | undefined;
			const body = JSON.parse(String(requestInit?.body)) as {
				model: string;
				messages: Array<{ role: string; content: string }>;
			};
			expect(body.model).toBe('gpt-4o');
			expect(body.messages).toHaveLength(2);
			expect(body.messages[1].content).toContain('Point Phase — Point is 6');
			expect(body.messages[1].content).toContain('Should I take odds now?');
			expect(body.messages[1].content).toContain('2(1+1)*');
			expect(body.messages[1].content).not.toContain('12(6+6)*');
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
		});

		const advice = await getCrapsAdvice(baseContext, {
			provider: 'openai',
			model: 'gpt-4o',
			apiKey: 'openai-key',
		});
		expect(advice.advice).toContain('pass line');
		expect(advice.suggestedBets).toEqual(['passLine', 'place6']);
		expect(advice.confidence).toBe('high');
	});

	test('calls Gemini and uses default query/history text for empty context values', async () => {
		setMockFetch(async (input: unknown, init?: unknown) => {
			expect(String(input)).toContain('generativelanguage.googleapis.com');
			expect(String(input)).toContain('gemini-1.5-flash');
			const requestInit = init as RequestInit | undefined;
			const body = JSON.parse(String(requestInit?.body)) as {
				contents: Array<{ parts: Array<{ text: string }> }>;
			};
			const prompt = body.contents[0].parts[0].text;
			expect(prompt).toContain('Come-Out Roll (no point yet)');
			expect(prompt).toContain('Active bets: None');
			expect(prompt).toContain('Recent rolls: No rolls yet');
			expect(prompt).toContain('What should I do next?');
			return new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								parts: [
									{
										text: '{"advice":"Yo-eleven energy. Start with pass line.","suggestedBets":["passLine"],"confidence":"medium"}',
									},
								],
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		});

		const advice = await getCrapsAdvice(
			{
				phase: 'come-out',
				point: null,
				chipBalance: 900,
				activeBets: [],
				rollHistory: [],
			},
			{
				provider: 'gemini',
				model: 'gemini-1.5-flash',
				apiKey: 'gemini-key',
			},
		);
		expect(advice.confidence).toBe('medium');
		expect(advice.suggestedBets).toEqual(['passLine']);
	});

	test('falls back when response has no JSON object', async () => {
		setMockFetch(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{ message: { content: 'Take a conservative line bet and watch the point.' } },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);

		const advice = await getCrapsAdvice(baseContext, {
			provider: 'openai',
			model: 'gpt-4o',
			apiKey: 'openai-key',
		});
		expect(advice.advice).toBe('Take a conservative line bet and watch the point.');
		expect(advice.suggestedBets).toEqual(['passLine']);
		expect(advice.confidence).toBe('low');
	});

	test('falls back to defaults for invalid parsed fields', async () => {
		setMockFetch(
			async () =>
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
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);

		const advice = await getCrapsAdvice(baseContext, {
			provider: 'openai',
			model: 'gpt-4o',
			apiKey: 'openai-key',
		});
		expect(advice.advice).toBe('Take single odds.');
		expect(advice.suggestedBets).toEqual(['passLine']);
		expect(advice.confidence).toBe('medium');
	});

	test('falls back when JSON parsing fails', async () => {
		setMockFetch(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: '{"advice":"Broken JSON",invalid}' } }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);

		const advice = await getCrapsAdvice(baseContext, {
			provider: 'openai',
			model: 'gpt-4o',
			apiKey: 'openai-key',
		});
		expect(advice.advice).toBe('{"advice":"Broken JSON",invalid}');
		expect(advice.suggestedBets).toEqual(['passLine']);
		expect(advice.confidence).toBe('low');
	});

	test('maps AbortError to timeout for OpenAI and Gemini', async () => {
		setMockFetch(async () => {
			const abortError = new Error('aborted');
			abortError.name = 'AbortError';
			throw abortError;
		});

		await expect(
			getCrapsAdvice(baseContext, {
				provider: 'openai',
				model: 'gpt-4o',
				apiKey: 'openai-key',
			}),
		).rejects.toThrow('Request timed out');

		await expect(
			getCrapsAdvice(baseContext, {
				provider: 'gemini',
				model: 'gemini-1.5-flash',
				apiKey: 'gemini-key',
			}),
		).rejects.toThrow('Request timed out');
	});

	test('propagates provider HTTP errors and unsupported providers', async () => {
		setMockFetch(
			async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
		);

		await expect(
			getCrapsAdvice(baseContext, {
				provider: 'openai',
				model: 'gpt-4o',
				apiKey: 'openai-key',
			}),
		).rejects.toThrow('OpenAI error 401');

		await expect(
			getCrapsAdvice(baseContext, {
				provider: 'gemini',
				model: 'gemini-1.5-flash',
				apiKey: 'gemini-key',
			}),
		).rejects.toThrow('Gemini error 401');

		await expect(
			getCrapsAdvice(baseContext, {
				provider: 'anthropic',
				model: 'claude',
				apiKey: 'key',
			} as any),
		).rejects.toThrow('Unsupported provider: anthropic');
	});
});
