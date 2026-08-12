import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { AIRivalAssistant } from './AIRivalAssistant';
import type { Card, Player } from './types';

// Mock DOM elements
function mockDocument() {
	if (typeof global.document === 'undefined') {
		// Mock HTMLButtonElement for instanceof checks
		(global as any).HTMLButtonElement = class {};

		(global as any).document = {
			getElementById: () => {
				const mockElement = {
					textContent: '',
					classList: {
						add: () => {},
						remove: () => {},
					},
					dataset: {},
					disabled: false,
				};
				// Make it pass instanceof HTMLButtonElement check
				Object.setPrototypeOf(mockElement, (global as any).HTMLButtonElement.prototype);
				return mockElement;
			},
		};
	}
}

function setLocalAiSettings(): void {
	(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
		getItem: (key: string) =>
			key === 'arcturus-ai-settings'
				? JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-local' })
				: null,
		setItem: () => {},
		removeItem: () => {},
		clear: () => {},
		key: () => null,
		length: 1,
	};
}

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
	isDealer: boolean = false,
): Player {
	return {
		id,
		name: `Player ${id}`,
		chips,
		hand,
		currentBet,
		totalBet: currentBet,
		folded: false,
		isAllIn: false,
		isDealer,
		isAI: id !== 0,
		hasActed: false,
	};
}

describe('AIRivalAssistant - browser-local settings', () => {
	test('hydrates local settings without fetching profile-backed settings', async () => {
		mockDocument();
		setLocalAiSettings();
		const calls: string[] = [];
		globalThis.fetch = mock((input: string | URL | Request) => {
			calls.push(typeof input === 'string' ? input : input.toString());
			return Promise.reject(new Error('unexpected network request'));
		}) as unknown as typeof fetch;

		const assistant = new AIRivalAssistant() as unknown as {
			aiSettings: { provider: string; model: string; apiKey: string } | null;
		};
		await Promise.resolve();

		expect(assistant.aiSettings).toEqual({
			provider: 'openai',
			model: 'gpt-4o',
			apiKey: 'sk-local',
		});
		expect(calls).toEqual([]);
	});
});

describe('AIRivalAssistant - Prompt Building', () => {
	let assistant: AIRivalAssistant;

	beforeEach(() => {
		mockDocument();
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ settings: null }), {
					status: 200,
				}),
			),
		);
		assistant = new AIRivalAssistant();
	});

	test('builds correct prompt for preflop phase', () => {
		const humanPlayer = player(0, 500, 0, [card('A', 'hearts', 14), card('K', 'spades', 13)]);
		const players = [humanPlayer, player(1, 500, 10), player(2, 500, 5)];

		// Access private method via reflection for testing
		const buildPrompt = (assistant as any).buildPrompt.bind(assistant);
		const prompt = buildPrompt('preflop', humanPlayer, [], 15, players);

		expect(prompt).toContain('PREFLOP');
		expect(prompt).toContain('A♥, K♠');
		expect(prompt).toContain('Not revealed yet');
		expect(prompt).toContain('$15');
		expect(prompt).toContain('$10'); // call amount
	});

	test('builds correct prompt for flop with community cards', () => {
		const humanPlayer = player(0, 500, 0, [card('Q', 'diamonds', 12), card('J', 'diamonds', 11)]);
		const communityCards = [
			card('10', 'diamonds', 10),
			card('9', 'hearts', 9),
			card('2', 'clubs', 2),
		];
		const players = [humanPlayer, player(1, 500, 20), player(2, 500, 20)];

		const buildPrompt = (assistant as any).buildPrompt.bind(assistant);
		const prompt = buildPrompt('flop', humanPlayer, communityCards, 60, players);

		expect(prompt).toContain('FLOP');
		expect(prompt).toContain('Q♦, J♦');
		expect(prompt).toContain('10♦, 9♥, 2♣');
		expect(prompt).toContain('$60');
		expect(prompt).toContain('$20'); // call amount
	});

	test('calculates call amount correctly', () => {
		const humanPlayer = player(0, 500, 10, []);
		const players = [humanPlayer, player(1, 500, 50), player(2, 500, 30)];

		const buildPrompt = (assistant as any).buildPrompt.bind(assistant);
		const prompt = buildPrompt('flop', humanPlayer, [], 90, players);

		// Highest bet is 50, player has bet 10, so call amount is 40
		expect(prompt).toContain('$40');
	});
});

describe('AIRivalAssistant - Response Parsing', () => {
	let assistant: AIRivalAssistant;

	beforeEach(() => {
		mockDocument();
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ settings: null }), {
					status: 200,
				}),
			),
		);
		assistant = new AIRivalAssistant();
	});

	test('parses valid JSON fold response', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"fold"}';
		const move = parseAiMove(response);

		expect(move.move).toBe('fold');
		expect(move.amount).toBeNull();
		expect(move.raw).toBe(response);
	});

	test('parses valid JSON check response', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"check"}';
		const move = parseAiMove(response);

		expect(move.move).toBe('check');
		expect(move.amount).toBeNull();
	});

	test('parses valid JSON call response', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"call"}';
		const move = parseAiMove(response);

		expect(move.move).toBe('call');
		expect(move.amount).toBeNull();
	});

	test('parses valid JSON raise response with amount', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"raise","amount":50}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBe(50);
	});

	test('extracts JSON from markdown code block', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '```json\n{"move":"raise","amount":75}\n```';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBe(75);
	});

	test('extracts JSON from text with surrounding content', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = 'Based on your hand, I recommend: {"move":"call"} which is the best play.';
		const move = parseAiMove(response);

		expect(move.move).toBe('call');
	});

	test('handles case-insensitive move types', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"RAISE","amount":100}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBe(100);
	});

	test('falls back to heuristic parsing when JSON invalid', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = 'I think you should fold this hand.';
		const move = parseAiMove(response);

		expect(move.move).toBe('fold');
	});

	test('defaults to check when no move detected', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = 'This is a difficult situation to analyze.';
		const move = parseAiMove(response);

		expect(move.move).toBe('check');
	});

	test('extracts amount from text for raise without JSON amount', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"raise"} I suggest raising to 120 chips.';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBe(120);
	});

	test('handles null amount in JSON', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"raise","amount":null}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBeNull();
	});

	test('handles string amount in JSON by converting to number', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"raise","amount":"85"}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBe(85);
	});

	test('handles NaN amount gracefully', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"raise","amount":"invalid"}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		expect(move.amount).toBeNull();
	});
});

describe('AIRivalAssistant - Raise Amount Clamping', () => {
	let assistant: AIRivalAssistant;

	beforeEach(() => {
		mockDocument();
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ settings: null }), {
					status: 200,
				}),
			),
		);
		assistant = new AIRivalAssistant();
	});

	test('clamps raise amount to minimum of 10', () => {
		const clampRaise = (assistant as any).clampRaise.bind(assistant);
		expect(clampRaise(5)).toBe(10);
		expect(clampRaise(1)).toBe(10);
		expect(clampRaise(0)).toBe(10);
	});

	test('clamps raise amount to maximum of 1000', () => {
		const clampRaise = (assistant as any).clampRaise.bind(assistant);
		expect(clampRaise(1500)).toBe(1000);
		expect(clampRaise(2000)).toBe(1000);
	});

	test('allows valid raise amounts in range', () => {
		const clampRaise = (assistant as any).clampRaise.bind(assistant);
		expect(clampRaise(50)).toBe(50);
		expect(clampRaise(100)).toBe(100);
		expect(clampRaise(500)).toBe(500);
	});

	test('rounds non-integer amounts', () => {
		const clampRaise = (assistant as any).clampRaise.bind(assistant);
		expect(clampRaise(75.7)).toBe(76);
		expect(clampRaise(123.4)).toBe(123);
	});

	test('returns null for null input', () => {
		const clampRaise = (assistant as any).clampRaise.bind(assistant);
		expect(clampRaise(null)).toBeNull();
	});

	test('returns null for NaN input', () => {
		const clampRaise = (assistant as any).clampRaise.bind(assistant);
		expect(clampRaise(NaN)).toBeNull();
	});
});

describe('AIRivalAssistant - shared AI client', () => {
	test('requests a move through the shared client', async () => {
		mockDocument();
		setLocalAiSettings();
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url:
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
				init,
			});
			return Promise.resolve(
				new Response(JSON.stringify({ choices: [{ message: { content: '{"move":"call"}' } }] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);
		}) as unknown as typeof fetch;

		const assistant = new AIRivalAssistant();
		const messages: string[] = [];
		await assistant.requestAiMove(
			'preflop',
			player(0, 500, 0, [card('A', 'hearts', 14), card('K', 'spades', 13)]),
			[],
			15,
			[player(0, 500, 0), player(1, 500, 10)],
			(message) => messages.push(message),
		);

		expect(calls).toHaveLength(1);
		expect(new URL(calls[0].url).pathname).toBe('/v1/chat/completions');
		expect(JSON.parse(String(calls[0].init?.body)).model).toBe('gpt-4o');
		expect(messages[0]).toContain('call');
	});
});

describe('AIRivalAssistant - Settings Management', () => {
	let assistant: AIRivalAssistant;

	beforeEach(() => {
		mockDocument();
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ settings: null }), {
					status: 200,
				}),
			),
		);
		assistant = new AIRivalAssistant();
		globalThis.fetch = mock(() => Promise.resolve(new Response()));
	});

	test('extracts OpenAI key from settings', () => {
		const getAiKey = (assistant as any).getAiKey.bind(assistant);
		const settings = {
			provider: 'openai' as const,
			model: 'gpt-4o',
			apiKey: 'sk-test123',
		};

		expect(getAiKey(settings)).toBe('sk-test123');
	});

	test('extracts Gemini key from settings', () => {
		const getAiKey = (assistant as any).getAiKey.bind(assistant);
		const settings = {
			provider: 'gemini' as const,
			model: 'gemini-2.0-flash-exp',
			apiKey: 'gem-test456',
		};

		expect(getAiKey(settings)).toBe('gem-test456');
	});

	test('returns null for missing provider key', () => {
		const getAiKey = (assistant as any).getAiKey.bind(assistant);
		const settings = {
			provider: 'openai' as const,
			model: 'gpt-4o',
			apiKey: '',
		};

		expect(getAiKey(settings)).toBeNull();
	});

	test('returns null for null settings', () => {
		const getAiKey = (assistant as any).getAiKey.bind(assistant);
		expect(getAiKey(null)).toBeNull();
	});
});

describe('AIRivalAssistant - Integration Logic', () => {
	let assistant: AIRivalAssistant;

	beforeEach(() => {
		mockDocument();
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ settings: null }), {
					status: 200,
				}),
			),
		);
		assistant = new AIRivalAssistant();
	});

	test('parsing fold recommendation works end-to-end', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{"move":"fold"}';
		const move = parseAiMove(response);

		expect(move.move).toBe('fold');
		expect(move.amount).toBeNull();
	});

	test('parsing raise with clamping works end-to-end', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const clampRaise = (assistant as any).clampRaise.bind(assistant);

		const response = '{"move":"raise","amount":2000}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		const clamped = clampRaise(move.amount);
		expect(clamped).toBe(1000); // Max clamped
	});

	test('parsing and clamping small raise', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const clampRaise = (assistant as any).clampRaise.bind(assistant);

		const response = '{"move":"raise","amount":3}';
		const move = parseAiMove(response);

		expect(move.move).toBe('raise');
		const clamped = clampRaise(move.amount);
		expect(clamped).toBe(10); // Min clamped
	});

	test('handles malformed JSON gracefully', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = '{move:raise,amount:50}'; // Invalid JSON (no quotes)
		const move = parseAiMove(response);

		// Should fall back to heuristic parsing
		expect(move.move).toBe('raise');
	});

	test('extracts move from verbose LLM response', () => {
		const parseAiMove = (assistant as any).parseAiMove.bind(assistant);
		const response = `Based on your position and the pot odds, I strongly recommend that you call this bet. 
		Here's the recommendation in JSON format: {"move":"call"} 
		This gives you the best chance of seeing the next card.`;
		const move = parseAiMove(response);

		expect(move.move).toBe('call');
	});
});
