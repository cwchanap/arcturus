import { describe, expect, test, beforeEach } from 'bun:test';
import { makeLLMDecision, clearLLMCache, type LLMSettings } from './llmAIStrategy';
import type { GameContext, Player, Card, BettingRound } from './types';

// Helper to create a card
function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

// Helper to create a player
function player(
	id: number,
	chips: number,
	currentBet: number,
	hand: Card[] = [],
	folded: boolean = false,
): Player {
	return {
		id,
		name: `Player ${id}`,
		chips,
		hand,
		currentBet,
		totalBet: currentBet,
		folded,
		isAllIn: false,
		isDealer: false,
		isAI: id !== 0,
		hasActed: false,
	};
}

// Helper to create test context
function createContext(
	aiPlayer: Player,
	players: Player[],
	communityCards: Card[] = [],
	pot: number = 20,
	phase: 'preflop' | 'flop' | 'turn' | 'river' = 'preflop',
): GameContext {
	return {
		player: aiPlayer,
		players,
		communityCards,
		pot,
		phase,
		minimumBet: 10,
		bettingRound:
			phase === 'preflop' || phase === 'flop' || phase === 'turn' || phase === 'river'
				? phase
				: 'preflop',
		position: 'middle',
	};
}

// Mock fetch globally
const originalFetch = global.fetch;

function mockFetch(
	responseGenerator: (url: string, options: Record<string, unknown>) => Promise<Response>,
): void {
	global.fetch = responseGenerator as typeof fetch;
}

function resetFetch(): void {
	global.fetch = originalFetch;
}

describe('llmAIStrategy', () => {
	beforeEach(() => {
		clearLLMCache();
		resetFetch();
	});

	describe('Fallback behavior', () => {
		test('falls back to rule-based when no LLM settings provided', async () => {
			const context = createContext(
				player(1, 1000, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]),
				],
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', null);

			expect(decision.action).toBeDefined();
			expect(['fold', 'check', 'call', 'raise']).toContain(decision.action);
			expect(decision.reasoning).toContain('rule-based fallback');
		});

		test('falls back to rule-based when LLM API fails', async () => {
			mockFetch(async () => {
				throw new Error('Network error');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('7', 'clubs', 7), card('2', 'diamonds', 2)]),
				[
					player(0, 1000, 50),
					player(1, 1000, 0, [card('7', 'clubs', 7), card('2', 'diamonds', 2)]),
				],
				[card('A', 'spades', 14), card('K', 'spades', 13), card('Q', 'spades', 12)],
				100,
				'flop',
			);

			const decision = await makeLLMDecision(context, 'tight-passive', llmSettings);

			expect(decision.action).toBeDefined();
			expect(decision.reasoning).toContain('LLM error fallback');
		});

		test('falls back when LLM response is invalid', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: 'This is not valid JSON!' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 800, 0, [card('Q', 'hearts', 12), card('J', 'hearts', 11)]),
				[player(0, 1000, 0), player(1, 800, 0, [card('Q', 'hearts', 12), card('J', 'hearts', 11)])],
			);

			const decision = await makeLLMDecision(context, 'loose-aggressive', llmSettings);

			expect(decision.action).toBeDefined();
			expect(decision.reasoning).toContain('LLM parse failed');
		});
	});

	describe('OpenAI integration', () => {
		test('successfully parses fold decision', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"fold","amount":0}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 500, 0, [card('7', 'clubs', 7), card('2', 'diamonds', 2)]),
				[
					player(0, 1000, 100),
					player(1, 500, 0, [card('7', 'clubs', 7), card('2', 'diamonds', 2)]),
				],
				[card('A', 'spades', 14), card('K', 'hearts', 13), card('Q', 'diamonds', 12)],
				200,
				'flop',
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(decision.action).toBe('fold');
			expect(decision.reasoning).toContain('LLM decision');
		});

		test('successfully parses check decision', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"check"}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-3.5-turbo',
			};

			const context = createContext(
				player(1, 1000, 0, [card('9', 'hearts', 9), card('8', 'hearts', 8)]),
				[player(0, 1000, 0), player(1, 1000, 0, [card('9', 'hearts', 9), card('8', 'hearts', 8)])],
				[card('7', 'hearts', 7), card('6', 'hearts', 6), card('5', 'hearts', 5)],
				50,
				'flop',
			);

			const decision = await makeLLMDecision(context, 'loose-passive', llmSettings);

			expect(decision.action).toBe('check');
			expect(decision.amount).toBe(0);
		});

		test('successfully parses raise decision', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise","amount":50}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]),
				[
					player(0, 1000, 20),
					player(1, 1000, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]),
				],
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(decision.action).toBe('raise');
			expect(decision.amount).toBe(50);
		});

		test('clamps raise amount to minimum bet', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise","amount":5}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('K', 'hearts', 13), card('Q', 'hearts', 12)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('K', 'hearts', 13), card('Q', 'hearts', 12)]),
				],
			);

			const decision = await makeLLMDecision(context, 'loose-aggressive', llmSettings);

			expect(decision.action).toBe('raise');
			expect(decision.amount).toBeGreaterThanOrEqual(10);
		});

		test('clamps raise amount to player chips', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise","amount":500}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 100, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]),
				[player(0, 1000, 0), player(1, 100, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)])],
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(decision.action).toBe('raise');
			expect(decision.amount).toBeLessThanOrEqual(100);
		});

		test('handles API error status', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response('Unauthorized', { status: 401 });
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'invalid-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('9', 'clubs', 9), card('8', 'clubs', 8)]),
				[player(0, 1000, 0), player(1, 1000, 0, [card('9', 'clubs', 9), card('8', 'clubs', 8)])],
			);

			const decision = await makeLLMDecision(context, 'loose-passive', llmSettings);

			expect(decision.action).toBeDefined();
			expect(decision.reasoning).toContain('LLM error fallback');
		});
	});

	describe('Gemini integration', () => {
		test('successfully parses fold decision', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('generativelanguage')) {
					return new Response(
						JSON.stringify({
							candidates: [{ content: { parts: [{ text: '{"action":"fold"}' }] } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'gemini',
				apiKey: 'test-key',
				model: 'gemini-pro',
			};

			const context = createContext(
				player(1, 600, 0, [card('7', 'diamonds', 7), card('2', 'clubs', 2)]),
				[player(0, 1000, 80), player(1, 600, 0, [card('7', 'diamonds', 7), card('2', 'clubs', 2)])],
				[card('A', 'hearts', 14), card('K', 'clubs', 13), card('Q', 'spades', 12)],
				160,
				'flop',
			);

			const decision = await makeLLMDecision(context, 'tight-passive', llmSettings);

			expect(decision.action).toBe('fold');
		});

		test('successfully parses raise decision', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('generativelanguage')) {
					return new Response(
						JSON.stringify({
							candidates: [{ content: { parts: [{ text: '{"action":"raise","amount":75}' }] } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'gemini',
				apiKey: 'test-key',
				model: 'gemini-pro',
			};

			const context = createContext(
				player(1, 1200, 0, [card('K', 'spades', 13), card('K', 'diamonds', 13)]),
				[
					player(0, 1000, 30),
					player(1, 1200, 0, [card('K', 'spades', 13), card('K', 'diamonds', 13)]),
				],
				[card('K', 'hearts', 13), card('7', 'clubs', 7), card('2', 'spades', 2)],
				80,
				'flop',
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(decision.action).toBe('raise');
			expect(decision.amount).toBe(75);
		});

		test('handles API error', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('generativelanguage')) {
					return new Response('API key invalid', { status: 400 });
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'gemini',
				apiKey: 'bad-key',
				model: 'gemini-pro',
			};

			const context = createContext(
				player(1, 1000, 0, [card('Q', 'clubs', 12), card('J', 'clubs', 11)]),
				[player(0, 1000, 0), player(1, 1000, 0, [card('Q', 'clubs', 12), card('J', 'clubs', 11)])],
			);

			const decision = await makeLLMDecision(context, 'loose-passive', llmSettings);

			expect(decision.reasoning).toContain('LLM error fallback');
		});

		test('handles empty response', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('generativelanguage')) {
					return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'gemini',
				apiKey: 'test-key',
				model: 'gemini-pro',
			};

			const context = createContext(
				player(1, 800, 0, [card('10', 'hearts', 10), card('9', 'hearts', 9)]),
				[player(0, 1000, 0), player(1, 800, 0, [card('10', 'hearts', 10), card('9', 'hearts', 9)])],
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			// Should fall back to rule-based (may contain "LLM parse failed" or just "fallback")
			expect(decision.reasoning).toMatch(/fallback|parse failed/i);
		});
	});

	describe('Response parsing', () => {
		test('parses JSON with extra text', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content: 'Based on analysis: {"action":"raise","amount":40} Strong hand.',
									},
								},
							],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('A', 'diamonds', 14), card('A', 'clubs', 14)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('A', 'diamonds', 14), card('A', 'clubs', 14)]),
				],
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(decision.action).toBe('raise');
			expect(decision.amount).toBe(40);
		});

		test('rejects invalid action types', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"invalid_action","amount":50}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('K', 'clubs', 13), card('Q', 'clubs', 12)]),
				[player(0, 1000, 0), player(1, 1000, 0, [card('K', 'clubs', 13), card('Q', 'clubs', 12)])],
			);

			const decision = await makeLLMDecision(context, 'loose-aggressive', llmSettings);

			expect(decision.reasoning).toContain('LLM parse failed');
		});

		test('handles malformed JSON', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise",amount:50' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('J', 'spades', 11), card('10', 'spades', 10)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('J', 'spades', 11), card('10', 'spades', 10)]),
				],
			);

			const decision = await makeLLMDecision(context, 'tight-passive', llmSettings);

			// Should fall back to rule-based (may contain "LLM parse failed" or "fallback")
			expect(decision.reasoning).toMatch(/fallback|parse failed/i);
		});

		test('handles non-numeric raise amount', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise","amount":"fifty"}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('Q', 'hearts', 12), card('Q', 'diamonds', 12)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('Q', 'hearts', 12), card('Q', 'diamonds', 12)]),
				],
			);

			const decision = await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(decision.action).toBeDefined();
			if (decision.action === 'raise') {
				expect(typeof decision.amount).toBe('number');
				expect(decision.amount).toBeGreaterThanOrEqual(10);
			}
		});
	});

	describe('Caching', () => {
		test('caches successful decisions', async () => {
			let callCount = 0;
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					callCount++;
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise","amount":50}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]),
				],
			);

			await makeLLMDecision(context, 'tight-aggressive', llmSettings);
			expect(callCount).toBe(1);

			const decision2 = await makeLLMDecision(context, 'tight-aggressive', llmSettings);
			expect(callCount).toBe(1); // Should not increase
			expect(decision2.reasoning).toContain('cached');
		});

		test('clearLLMCache clears the cache', async () => {
			let callCount = 0;
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					callCount++;
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"call"}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('J', 'hearts', 11), card('10', 'hearts', 10)]),
				[
					player(0, 1000, 20),
					player(1, 1000, 0, [card('J', 'hearts', 11), card('10', 'hearts', 10)]),
				],
			);

			await makeLLMDecision(context, 'loose-passive', llmSettings);
			expect(callCount).toBe(1);

			clearLLMCache();

			await makeLLMDecision(context, 'loose-passive', llmSettings);
			expect(callCount).toBe(2);
		});

		test('different contexts produce different cache keys', async () => {
			let callCount = 0;
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					callCount++;
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"check"}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context1 = createContext(
				player(1, 1000, 0, [card('9', 'clubs', 9), card('8', 'clubs', 8)]),
				[player(0, 1000, 0), player(1, 1000, 0, [card('9', 'clubs', 9), card('8', 'clubs', 8)])],
			);

			const context2 = createContext(
				player(1, 1000, 0, [card('9', 'clubs', 9), card('8', 'clubs', 8)]),
				[player(0, 1000, 0), player(1, 1000, 0, [card('9', 'clubs', 9), card('8', 'clubs', 8)])],
				[card('7', 'clubs', 7)],
				20,
				'flop',
			);

			await makeLLMDecision(context1, 'loose-aggressive', llmSettings);
			expect(callCount).toBe(1);

			await makeLLMDecision(context2, 'loose-aggressive', llmSettings);
			expect(callCount).toBe(2); // Different context
		});
	});

	describe('Personality integration', () => {
		test('tight-aggressive personality in prompt', async () => {
			let capturedPrompt = '';
			mockFetch(async (url: string, options: Record<string, unknown>) => {
				if (url.includes('openai')) {
					const body = JSON.parse(options.body as string);
					capturedPrompt = body.messages[1].content;
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"raise","amount":30}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('K', 'diamonds', 13), card('Q', 'diamonds', 12)]),
				[
					player(0, 1000, 0),
					player(1, 1000, 0, [card('K', 'diamonds', 13), card('Q', 'diamonds', 12)]),
				],
			);

			await makeLLMDecision(context, 'tight-aggressive', llmSettings);

			expect(capturedPrompt).toContain('conservative and aggressive');
		});

		test('loose-passive personality in prompt', async () => {
			let capturedPrompt = '';
			mockFetch(async (url: string, options: Record<string, unknown>) => {
				if (url.includes('openai')) {
					const body = JSON.parse(options.body as string);
					capturedPrompt = body.messages[1].content;
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: '{"action":"call"}' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4',
			};

			const context = createContext(
				player(1, 1000, 0, [card('7', 'spades', 7), card('6', 'spades', 6)]),
				[player(0, 1000, 10), player(1, 1000, 0, [card('7', 'spades', 7), card('6', 'spades', 6)])],
			);

			await makeLLMDecision(context, 'loose-passive', llmSettings);

			expect(capturedPrompt).toContain('loose and passive');
		});
	});
});
