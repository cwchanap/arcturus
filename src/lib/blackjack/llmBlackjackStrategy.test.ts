import { describe, expect, test, afterEach } from 'bun:test';
import {
	getBlackjackAdvice,
	getRoundCommentary,
	type LLMSettings,
	type BlackjackAdviceContext,
} from './llmBlackjackStrategy';
import type { Card, Hand } from './types';

// Helper to create a card
function card(rank: Card['rank'], suit: Card['suit']): Card {
	return { rank, suit };
}

// Helper to create a hand
function hand(cards: Card[], bet: number = 100): Hand {
	return { cards, bet, isDealer: false };
}

// Helper to create dealer hand
function dealerHand(cards: Card[]): Hand {
	return { cards, bet: 0, isDealer: true };
}

// Helper to create test context
function createContext(
	playerCards: Card[],
	dealerUpCard: Card,
	availableActions: BlackjackAdviceContext['availableActions'] = ['hit', 'stand'],
	playerBalance: number = 1000,
	currentBet: number = 100,
): BlackjackAdviceContext {
	return {
		playerHand: hand(playerCards, currentBet),
		dealerUpCard,
		availableActions,
		playerBalance,
		currentBet,
	};
}

// Mock fetch globally
const originalFetch = global.fetch;

function mockFetch(
	responseGenerator: (url: string, options: RequestInit) => Promise<Response>,
): void {
	global.fetch = responseGenerator as typeof fetch;
}

function resetFetch(): void {
	global.fetch = originalFetch;
}

describe('llmBlackjackStrategy', () => {
	afterEach(() => {
		resetFetch();
	});

	describe('getBlackjackAdvice', () => {
		describe('Fallback behavior', () => {
			test('falls back to basic strategy when no LLM settings provided', async () => {
				const context = createContext(
					[card('10', 'hearts'), card('6', 'spades')],
					card('7', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBeDefined();
				expect(['hit', 'stand']).toContain(advice.recommendedAction);
				expect(advice.reasoning).toContain('basic strategy');
			});

			test('falls back to basic strategy when API key is empty', async () => {
				const llmSettings: LLMSettings = {
					provider: 'openai',
					apiKey: '',
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('A', 'hearts'), card('7', 'spades')],
					card('9', 'diamonds'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBeDefined();
				expect(advice.reasoning).toContain('basic strategy');
			});

			test('falls back to basic strategy when LLM API fails', async () => {
				mockFetch(async () => {
					throw new Error('Network error');
				});

				const llmSettings: LLMSettings = {
					provider: 'openai',
					apiKey: 'test-key',
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('8', 'clubs'), card('8', 'diamonds')],
					card('6', 'hearts'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBeDefined();
				expect(advice.reasoning).toContain('LLM unavailable');
			});

			test('falls back when LLM response is invalid JSON', async () => {
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
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('Q', 'hearts'), card('5', 'spades')],
					card('10', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBeDefined();
				expect(advice.reasoning).toContain('LLM response could not be parsed');
			});

			test('falls back when LLM returns invalid action', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(
							JSON.stringify({
								choices: [{ message: { content: '{"action":"surrender","reasoning":"give up"}' } }],
							}),
							{ status: 200 },
						);
					}
					throw new Error('Unexpected URL');
				});

				const llmSettings: LLMSettings = {
					provider: 'openai',
					apiKey: 'test-key',
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('7', 'hearts'), card('9', 'spades')],
					card('A', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBeDefined();
				expect(advice.reasoning).toContain('basic strategy');
			});
		});

		describe('OpenAI integration', () => {
			test('successfully parses hit decision', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content:
												'{"action":"hit","reasoning":"With 12 against dealer 10, hit to improve hand"}',
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
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('7', 'hearts'), card('5', 'spades')],
					card('10', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBe('hit');
				expect(advice.reasoning).toContain('12');
				expect(advice.confidence).toBeGreaterThan(0);
			});

			test('successfully parses stand decision', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content:
												'{"action":"stand","reasoning":"With 18, stand and hope dealer busts"}',
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
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('10', 'hearts'), card('8', 'spades')],
					card('6', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBe('stand');
				expect(advice.reasoning).toContain('18');
			});

			test('successfully parses double-down decision', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content:
												'{"action":"double-down","reasoning":"With 11 against dealer 6, double down for maximum value"}',
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
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('6', 'hearts'), card('5', 'spades')],
					card('6', 'clubs'),
					['hit', 'stand', 'double-down'],
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBe('double-down');
				expect(advice.reasoning).toContain('11');
			});

			test('successfully parses split decision', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content: '{"action":"split","reasoning":"Always split 8s - basic strategy"}',
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
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('8', 'hearts'), card('8', 'spades')],
					card('5', 'clubs'),
					['hit', 'stand', 'split'],
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBe('split');
				expect(advice.reasoning).toContain('8');
			});

			test('handles API error response', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
							status: 401,
						});
					}
					throw new Error('Unexpected URL');
				});

				const llmSettings: LLMSettings = {
					provider: 'openai',
					apiKey: 'invalid-key',
					model: 'gpt-4o',
				};

				const context = createContext(
					[card('J', 'hearts'), card('4', 'spades')],
					card('9', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBeDefined();
				expect(advice.reasoning).toContain('LLM unavailable');
			});

			test('marks unavailable action with reduced confidence', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('openai')) {
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content:
												'{"action":"double-down","reasoning":"Double down would be ideal here"}',
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
					model: 'gpt-4o',
				};

				// Context where double-down is NOT available (only hit/stand)
				const context = createContext(
					[card('5', 'hearts'), card('6', 'spades')],
					card('7', 'clubs'),
					['hit', 'stand'], // No double-down
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				// Action should be null since double-down is not available
				expect(advice.recommendedAction).toBeNull();
				expect(advice.reasoning).toContain('not available');
				expect(advice.confidence).toBeLessThan(0.7);
			});
		});

		describe('Gemini integration', () => {
			test('successfully parses Gemini response', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('generativelanguage.googleapis.com')) {
						return new Response(
							JSON.stringify({
								candidates: [
									{
										content: {
											parts: [
												{
													text: '{"action":"hit","reasoning":"Need to improve this hand"}',
												},
											],
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
					provider: 'gemini',
					apiKey: 'test-gemini-key',
					model: 'gemini-2.5-flash',
				};

				const context = createContext(
					[card('4', 'hearts'), card('5', 'spades')],
					card('10', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBe('hit');
				expect(advice.reasoning).toContain('improve');
			});

			test('handles Gemini API error', async () => {
				mockFetch(async (url: string) => {
					if (url.includes('generativelanguage.googleapis.com')) {
						return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
							status: 429,
						});
					}
					throw new Error('Unexpected URL');
				});

				const llmSettings: LLMSettings = {
					provider: 'gemini',
					apiKey: 'test-gemini-key',
					model: 'gemini-2.5-flash',
				};

				const context = createContext(
					[card('K', 'hearts'), card('3', 'spades')],
					card('8', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, llmSettings);

				expect(advice.recommendedAction).toBeDefined();
				expect(advice.reasoning).toContain('LLM unavailable');
			});
		});

		describe('Basic strategy fallback', () => {
			test('recommends hit on low hands', async () => {
				const context = createContext(
					[card('5', 'hearts'), card('4', 'spades')],
					card('10', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('hit');
				expect(advice.reasoning).toContain('9');
			});

			test('recommends stand on high hands', async () => {
				const context = createContext(
					[card('K', 'hearts'), card('8', 'spades')],
					card('6', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('stand');
				expect(advice.reasoning).toContain('18');
			});

			test('recommends double-down on 11', async () => {
				const context = createContext(
					[card('6', 'hearts'), card('5', 'spades')],
					card('6', 'clubs'),
					['hit', 'stand', 'double-down'],
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('double-down');
				expect(advice.reasoning).toContain('11');
			});

			test('recommends split on 8s', async () => {
				const context = createContext(
					[card('8', 'hearts'), card('8', 'spades')],
					card('5', 'clubs'),
					['hit', 'stand', 'split'],
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('split');
				expect(advice.reasoning).toContain('8');
			});

			test('recommends split on Aces', async () => {
				const context = createContext(
					[card('A', 'hearts'), card('A', 'spades')],
					card('7', 'clubs'),
					['hit', 'stand', 'split'],
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('split');
				expect(advice.reasoning).toContain('A');
			});

			test('recommends hit on 12-16 against dealer 7+', async () => {
				const context = createContext(
					[card('10', 'hearts'), card('4', 'spades')],
					card('9', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('hit');
				expect(advice.reasoning).toContain('14');
			});

			test('recommends stand on 12-16 against dealer 2-6', async () => {
				const context = createContext(
					[card('10', 'hearts'), card('4', 'spades')],
					card('5', 'clubs'),
				);

				const advice = await getBlackjackAdvice(context, null);

				expect(advice.recommendedAction).toBe('stand');
				expect(advice.reasoning).toContain('14');
			});
		});
	});

	describe('getRoundCommentary', () => {
		test('returns default win comment without LLM', async () => {
			const player = hand([card('10', 'hearts'), card('9', 'spades')]);
			const dealer = dealerHand([card('10', 'clubs'), card('7', 'diamonds')]);

			const comment = await getRoundCommentary(player, dealer, 'win', null);

			expect(comment).toContain('win');
		});

		test('returns default loss comment without LLM', async () => {
			const player = hand([card('10', 'hearts'), card('5', 'spades')]);
			const dealer = dealerHand([card('10', 'clubs'), card('8', 'diamonds')]);

			const comment = await getRoundCommentary(player, dealer, 'loss', null);

			expect(comment).toBeDefined();
			expect(comment.length).toBeGreaterThan(0);
		});

		test('returns default push comment without LLM', async () => {
			const player = hand([card('10', 'hearts'), card('8', 'spades')]);
			const dealer = dealerHand([card('10', 'clubs'), card('8', 'diamonds')]);

			const comment = await getRoundCommentary(player, dealer, 'push', null);

			expect(comment).toContain('push');
		});

		test('returns default blackjack comment without LLM', async () => {
			const player = hand([card('A', 'hearts'), card('K', 'spades')]);
			const dealer = dealerHand([card('10', 'clubs'), card('7', 'diamonds')]);

			const comment = await getRoundCommentary(player, dealer, 'blackjack', null);

			expect(comment.toLowerCase()).toContain('blackjack');
		});

		test('returns LLM-generated comment when available', async () => {
			mockFetch(async (url: string) => {
				if (url.includes('openai')) {
					return new Response(
						JSON.stringify({
							choices: [{ message: { content: 'Great hand! You played that perfectly.' } }],
						}),
						{ status: 200 },
					);
				}
				throw new Error('Unexpected URL');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4o',
			};

			const player = hand([card('10', 'hearts'), card('9', 'spades')]);
			const dealer = dealerHand([card('10', 'clubs'), card('6', 'diamonds'), card('7', 'hearts')]);

			const comment = await getRoundCommentary(player, dealer, 'win', llmSettings);

			expect(comment).toContain('perfectly');
		});

		test('returns default comment on LLM error', async () => {
			mockFetch(async () => {
				throw new Error('API Error');
			});

			const llmSettings: LLMSettings = {
				provider: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4o',
			};

			const player = hand([card('10', 'hearts'), card('5', 'spades')]);
			const dealer = dealerHand([card('10', 'clubs'), card('8', 'diamonds')]);

			const comment = await getRoundCommentary(player, dealer, 'loss', llmSettings);

			// Should return default comment, not throw
			expect(comment).toBeDefined();
			expect(comment.length).toBeGreaterThan(0);
		});
	});
});
