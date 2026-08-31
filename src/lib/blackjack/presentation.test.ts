import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Card, HandValue } from './types';
import {
	createBlackjackCardElement,
	formatBlackjackHandValue,
	renderBlackjackDealer,
	renderBlackjackPlayerHands,
} from './presentation';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});

afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

const HARD_17: HandValue = { value: 17, isSoft: false, isBust: false };
const SOFT_17: HandValue = { value: 17, isSoft: true, isBust: false };
const BUST_23: HandValue = { value: 23, isSoft: false, isBust: true };

describe('formatBlackjackHandValue', () => {
	test('prefixes Bust with the raw value', () => {
		expect(formatBlackjackHandValue(BUST_23)).toBe('Bust 23');
	});

	test('prefixes Soft with the soft total', () => {
		expect(formatBlackjackHandValue(SOFT_17)).toBe('Soft 17');
	});

	test('renders a hard total as a bare number', () => {
		expect(formatBlackjackHandValue(HARD_17)).toBe('17');
	});

	test('localizes bust and soft labels through the locale argument', () => {
		expect(formatBlackjackHandValue(BUST_23, 'zh-Hant')).toBe('爆牌 23');
		expect(formatBlackjackHandValue(SOFT_17, 'ja')).toBe('ソフト 17');
		expect(formatBlackjackHandValue(HARD_17, 'zh-Hant')).toBe('17');
	});
});

describe('createBlackjackCardElement', () => {
	test('uses a red class for hearts and diamonds', () => {
		const hearts = createBlackjackCardElement(document, { rank: 'A', suit: 'hearts' }, 'card');
		const diamonds = createBlackjackCardElement(document, { rank: 'A', suit: 'diamonds' }, 'card');
		expect(hearts.classList.contains('text-red-700')).toBe(true);
		expect(diamonds.classList.contains('text-red-700')).toBe(true);
		expect(hearts.classList.contains('text-slate-900')).toBe(false);
	});

	test('uses the dark class for clubs and spades', () => {
		const clubs = createBlackjackCardElement(document, { rank: 'A', suit: 'clubs' }, 'card');
		const spades = createBlackjackCardElement(document, { rank: 'A', suit: 'spades' }, 'card');
		expect(clubs.classList.contains('text-slate-900')).toBe(true);
		expect(spades.classList.contains('text-slate-900')).toBe(true);
		expect(clubs.classList.contains('text-red-700')).toBe(false);
	});

	test('exposes an accessible name and a glyph-rendered text content', () => {
		const card = createBlackjackCardElement(
			document,
			{ rank: '10', suit: 'hearts' },
			'ranked-dealer-card',
		);
		expect(card.getAttribute('role')).toBe('img');
		expect(card.getAttribute('aria-label')).toBe('10 of hearts');
		expect(card.textContent).toBe('10♥');
		expect(card.dataset.testid).toBe('ranked-dealer-card');
	});

	test('is queryable by the img role with the expected accessible name', () => {
		document.body.replaceChildren();
		const card = createBlackjackCardElement(
			document,
			{ rank: 'K', suit: 'spades' },
			'ranked-player-card',
		);
		document.body.append(card);

		const byRole = document.querySelector('[role="img"]');
		expect(byRole).toBe(card);
		expect(byRole?.getAttribute('aria-label')).toBe('K of spades');
	});

	test('uses the document passed in (decouples from the global)', () => {
		const isolated = new Window();
		try {
			const card = createBlackjackCardElement(
				isolated.document,
				{ rank: 'K', suit: 'spades' },
				'iso-card',
			);
			expect(card.ownerDocument).toBe(isolated.document);
			expect(card.textContent).toBe('K♠');
		} finally {
			isolated.close();
		}
	});
});

describe('renderBlackjackDealer', () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	test('renders only the projected cards and writes the formatted value', () => {
		const dealerHand = document.createElement('div');
		const dealerValue = document.createElement('span');
		document.body.append(dealerHand, dealerValue);

		renderBlackjackDealer(
			document,
			dealerHand,
			dealerValue,
			{
				cards: [
					{ rank: '7', suit: 'spades' },
					{ rank: '10', suit: 'hearts' },
				],
				value: HARD_17,
			},
			{ testIdPrefix: 'ranked' },
		);

		const rendered = dealerHand.querySelectorAll('[data-testid="ranked-dealer-card"]');
		expect(rendered).toHaveLength(2);
		expect(dealerValue.textContent).toBe('17');
		expect(dealerHand.querySelector('[aria-label*="face down" i]')).toBeNull();
	});

	test('honors an alternate test-id prefix', () => {
		const dealerHand = document.createElement('div');
		const dealerValue = document.createElement('span');
		document.body.append(dealerHand, dealerValue);

		renderBlackjackDealer(
			document,
			dealerHand,
			dealerValue,
			{ cards: [{ rank: 'A', suit: 'clubs' }], value: SOFT_17 },
			{ testIdPrefix: 'daily-challenge' },
		);

		expect(dealerHand.querySelectorAll('[data-testid="daily-challenge-dealer-card"]')).toHaveLength(
			1,
		);
		expect(dealerHand.querySelector('[data-testid="ranked-dealer-card"]')).toBeNull();
		expect(dealerValue.textContent).toBe('Soft 17');
	});

	test('clears the container when no cards are projected', () => {
		const dealerHand = document.createElement('div');
		const dealerValue = document.createElement('span');
		dealerHand.append(createBlackjackCardElement(document, { rank: '2', suit: 'clubs' }, 'stale'));
		document.body.append(dealerHand, dealerValue);

		renderBlackjackDealer(
			document,
			dealerHand,
			dealerValue,
			{ cards: [], value: HARD_17 },
			{ testIdPrefix: 'ranked' },
		);

		expect(dealerHand.children).toHaveLength(0);
	});
});

describe('renderBlackjackPlayerHands', () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	test('renders label, value, and cards for each hand and styles the active hand', () => {
		const playerHands = document.createElement('div');
		document.body.append(playerHands);
		const hands = [
			{
				cards: [{ rank: 'A', suit: 'clubs' }] as readonly Card[],
				wager: 100,
				value: SOFT_17,
			},
			{
				cards: [
					{ rank: 'K', suit: 'spades' },
					{ rank: 'Q', suit: 'diamonds' },
				] as readonly Card[],
				wager: 100,
				value: BUST_23,
			},
		];

		renderBlackjackPlayerHands(document, playerHands, hands, 0, {
			testIdPrefix: 'ranked',
			formatWager: (value) => `$${value}`,
		});

		const sections = playerHands.querySelectorAll('[data-testid="ranked-player-hand"]');
		expect(sections).toHaveLength(2);

		const active = sections[0] as HTMLElement;
		const inactive = sections[1] as HTMLElement;
		expect(active.dataset.active).toBe('true');
		expect(inactive.dataset.active).toBe('false');
		expect(active.classList.contains('border-2')).toBe(true);
		expect(inactive.classList.contains('border-2')).toBe(false);

		const values = Array.from(
			playerHands.querySelectorAll<HTMLElement>('[data-testid="ranked-player-value"]'),
		).map((element) => element.textContent);
		expect(values).toEqual(['Soft 17', 'Bust 23']);

		expect(active.textContent).toContain('Hand 1 · $100');
		expect(inactive.textContent).toContain('Hand 2 · $100');

		expect(playerHands.querySelectorAll('[data-testid="ranked-player-card"]')).toHaveLength(3);
	});

	test('formats the wager through the provided formatter', () => {
		const playerHands = document.createElement('div');
		document.body.append(playerHands);

		renderBlackjackPlayerHands(
			document,
			playerHands,
			[{ cards: [{ rank: '5', suit: 'hearts' }], wager: 250, value: HARD_17 }],
			0,
			{
				testIdPrefix: 'daily-challenge',
				formatWager: (value) => `${value} chips`,
			},
		);

		expect(
			playerHands.querySelector('[data-testid="daily-challenge-player-hand"]')?.textContent,
		).toContain('Hand 1 · 250 chips');
		expect(playerHands.querySelector('[data-testid="ranked-player-hand"]')).toBeNull();
	});

	test('replaces existing hands instead of appending', () => {
		const playerHands = document.createElement('div');
		playerHands.append(document.createElement('section'));
		document.body.append(playerHands);

		renderBlackjackPlayerHands(document, playerHands, [], 0, {
			testIdPrefix: 'ranked',
			formatWager: (value) => `$${value}`,
		});

		expect(playerHands.children).toHaveLength(0);
	});
});
