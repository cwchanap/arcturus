import { afterEach, describe, expect, test } from 'bun:test';
import {
	getBlackjackAdvice,
	getBlackjackStrategyAdvice,
	type BlackjackAdviceContext,
} from './llmBlackjackStrategy';
import { SUPPORTED_LOCALES } from '../i18n/locale';
import type { AiSettings } from '../ai';
import type { Card, Hand } from './types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
	return { rank, suit };
}

function hand(cards: Card[], bet: number = 100): Hand {
	return { cards, bet, isDealer: false };
}

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

const settings: AiSettings = {
	provider: 'openai',
	model: 'gpt-4o',
	apiKey: 'test-key',
};

const originalFetch = global.fetch;

function mockFetch(
	responseGenerator: (url: string, options: RequestInit) => Promise<Response>,
): void {
	global.fetch = responseGenerator as typeof fetch;
}

afterEach(() => {
	global.fetch = originalFetch;
});

describe('Blackjack strategy advice', () => {
	test('chooses a legal deterministic hit for a low hand', () => {
		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);

		const local = getBlackjackStrategyAdvice(context);

		expect(local.recommendedAction).toBe('hit');
		expect(context.availableActions).toContain(local.recommendedAction!);
		expect(local.confidence).toBe(1);
		expect(local.reasoning).toContain('(basic strategy)');
	});

	test('chooses stand for a high hand', () => {
		const context = createContext([card('K', 'hearts'), card('8', 'spades')], card('6', 'clubs'));

		expect(getBlackjackStrategyAdvice(context).recommendedAction).toBe('stand');
	});

	test('chooses double-down when the preferred move is available', () => {
		const context = createContext([card('6', 'hearts'), card('5', 'spades')], card('6', 'clubs'), [
			'hit',
			'stand',
			'double-down',
		]);

		expect(getBlackjackStrategyAdvice(context).recommendedAction).toBe('double-down');
	});

	test('chooses split for aces and eights when available', () => {
		const context = createContext([card('8', 'hearts'), card('8', 'spades')], card('5', 'clubs'), [
			'hit',
			'stand',
			'split',
		]);

		expect(getBlackjackStrategyAdvice(context).recommendedAction).toBe('split');
	});

	test('falls back to another legal action when the preferred move is unavailable', () => {
		const context = createContext([card('6', 'hearts'), card('5', 'spades')], card('6', 'clubs'), [
			'stand',
		]);
		const local = getBlackjackStrategyAdvice(context);

		expect(local.recommendedAction).toBe('stand');
		expect(context.availableActions).toContain(local.recommendedAction!);
	});

	test('returns local advice when no provider settings are available', async () => {
		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);

		expect(await getBlackjackAdvice(context, null)).toEqual(getBlackjackStrategyAdvice(context));
	});

	test('ask-ai-only actions yield no recommendation and skip the provider', async () => {
		let fetchCalled = false;
		mockFetch(async () => {
			fetchCalled = true;
			return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
		});

		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['ask-ai'],
		);

		const advice = await getBlackjackAdvice(context, settings);

		expect(advice.recommendedAction).toBeNull();
		expect(fetchCalled).toBe(false);
	});

	test('provider output can rewrite reasoning but cannot change the local action', async () => {
		mockFetch(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content:
										'{"action":"stand","reasoning":"Dealer pressure still favors taking a card."}',
								},
							},
						],
					}),
				),
		);

		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);

		const advice = await getBlackjackAdvice(context, settings);

		expect(advice.recommendedAction).toBe('hit');
		expect(advice.reasoning).toContain('Dealer pressure');
		expect(advice.raw).toContain('Dealer pressure');
	});

	test('provider failure returns exactly the deterministic local advice', async () => {
		mockFetch(async () => {
			throw new Error('network down');
		});

		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);
		const local = getBlackjackStrategyAdvice(context);

		expect(await getBlackjackAdvice(context, settings)).toEqual(local);
	});

	test('provider response without reasoning returns exactly the deterministic advice', async () => {
		mockFetch(
			async () =>
				new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"stand"}' } }] })),
		);

		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);
		const local = getBlackjackStrategyAdvice(context);

		expect(await getBlackjackAdvice(context, settings)).toEqual(local);
	});

	test('recommends the identical action in every supported locale', () => {
		const context = createContext([card('6', 'hearts'), card('5', 'spades')], card('6', 'clubs'), [
			'hit',
			'stand',
			'double-down',
		]);

		const actions = SUPPORTED_LOCALES.map((locale) =>
			getBlackjackStrategyAdvice(context, locale),
		).map((advice) => advice.recommendedAction);

		expect(new Set(actions)).toEqual(new Set(['double-down']));
	});

	test('localizes deterministic reasoning without changing the move', () => {
		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);

		const en = getBlackjackStrategyAdvice(context, 'en');
		const zhHant = getBlackjackStrategyAdvice(context, 'zh-Hant');
		const ja = getBlackjackStrategyAdvice(context, 'ja');

		expect(en.recommendedAction).toBe('hit');
		expect(zhHant.recommendedAction).toBe('hit');
		expect(ja.recommendedAction).toBe('hit');
		expect(en.reasoning).toContain('(basic strategy)');
		expect(zhHant.reasoning).toContain('基本策略');
		expect(ja.reasoning).toContain('ベーシックストラテジー');
	});

	test('the provider prompt requests the active locale but cannot change the action', async () => {
		let body = '';
		mockFetch(async (_url, init) => {
			body = typeof init.body === 'string' ? init.body : '';
			return new Response(
				JSON.stringify({ choices: [{ message: { content: '{"reasoning":"中文說明。"}' } }] }),
			);
		});

		const context = createContext(
			[card('10', 'hearts'), card('6', 'spades')],
			card('10', 'clubs'),
			['hit', 'stand'],
		);
		const advice = await getBlackjackAdvice(context, settings, 'zh-Hant');

		expect(advice.recommendedAction).toBe('hit');
		expect(body).toContain('zh-Hant');
		expect(advice.reasoning).toBe('中文說明。');
	});
});
