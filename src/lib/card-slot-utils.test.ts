/**
 * Unit tests for card-slot-utils
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
	setSlotState,
	renderCardsToContainer,
	clearCardsContainer,
	setContainerHighlight,
	type CardData,
} from './card-slot-utils';

// Mock types for DOM elements
type MockElement = {
	classList: {
		add: (...classes: string[]) => void;
		remove: (...classes: string[]) => void;
		contains: (cls: string) => boolean;
		toggle: (cls: string, force?: boolean) => boolean;
	};
	setAttribute: (name: string, value: string) => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => MockElement | null;
	querySelectorAll: (selector: string) => MockElement[];
	textContent?: string;
	id?: string;
	className?: string;
	children?: MockElement[];
};

// Create mock element factory
function createMockElement(tagName: string, attributes: Record<string, string> = {}): MockElement {
	const classList: string[] = [];
	const element: MockElement = {
		classList: {
			add: (...classes) => classList.push(...classes),
			remove: (...classes) => {
				for (const cls of classes) {
					const idx = classList.indexOf(cls);
					if (idx > -1) classList.splice(idx, 1);
				}
			},
			contains: (cls) => classList.includes(cls),
			toggle: (cls, force) => {
				const has = classList.includes(cls);
				if (force === undefined) force = !has;
				if (force && !has) classList.push(cls);
				if (!force && has) {
					const idx = classList.indexOf(cls);
					if (idx > -1) classList.splice(idx, 1);
				}
				return force;
			},
		},
		setAttribute: function (name, value) {
			this['_attr_' + name] = value;
		},
		getAttribute: function (name) {
			return this['_attr_' + name] || null;
		},
		querySelector: function (selector) {
			if (selector === '[data-placeholder]') return this['_placeholder'] || null;
			if (selector === '[data-card-face]') return this['_cardFace'] || null;
			if (selector === '[data-card-back]') return this['_cardBack'] || null;
			if (selector === '[data-rank]') return (this['_rankEls'] && this['_rankEls'][0]) || null;
			if (selector === '[data-suit-small], [data-suit-center]')
				return (this['_suitEls'] && this['_suitEls'][0]) || null;
			return null;
		},
		querySelectorAll: function (selector) {
			if (selector === '[data-rank]') return this['_rankEls'] || [];
			if (selector === '[data-suit-small], [data-suit-center]') return this['_suitEls'] || [];
			if (selector === '.card-slot') return this['_slots'] || [];
			return [];
		},
		textContent: '',
	};

	// Set attributes
	Object.assign(element, attributes);

	return element;
}

// Mock document.getElementById
global.document = {
	getElementById: (id: string) => {
		if (id === 'test-container') return globalThis['_mockContainer'] || null;
		return null;
	},
} as any;

describe('card-slot-utils', () => {
	let mockContainer: MockElement;
	let mockSlots: MockElement[];

	beforeEach(() => {
		// Create mock container
		mockContainer = createMockElement('div', { id: 'test-container' });
		mockSlots = [];

		// Create mock slots with child elements
		for (let i = 0; i < 5; i++) {
			const slot = createMockElement('div', { className: 'card-slot' });

			// Add placeholder element
			const placeholder = createMockElement('div');
			slot['_placeholder'] = placeholder;

			// Add card face element
			const cardFace = createMockElement('div');
			slot['_cardFace'] = cardFace;

			// Add rank and suit elements for card face
			const rankEl = createMockElement('span');
			rankEl.textContent = ''; // Initialize textContent
			cardFace['_rankEl'] = rankEl;
			cardFace['_rankEls'] = [rankEl];

			const suitEl = createMockElement('span');
			suitEl.textContent = ''; // Initialize textContent
			cardFace['_suitEl'] = suitEl;
			cardFace['_suitEls'] = [suitEl, suitEl]; // Two elements for small and center

			// Add card back element
			const cardBack = createMockElement('div');
			slot['_cardBack'] = cardBack;

			mockSlots.push(slot);
		}

		// Set up container with slots
		mockContainer['_slots'] = mockSlots;
		globalThis['_mockContainer'] = mockContainer;
	});

	describe('setSlotState', () => {
		test('should set slot to hidden state', () => {
			setSlotState(mockSlots[0], 'hidden');

			expect(mockSlots[0].classList.contains('hidden')).toBe(true);
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('hidden');

			const placeholder = mockSlots[0].querySelector('[data-placeholder]');
			const cardFace = mockSlots[0].querySelector('[data-card-face]');
			const cardBack = mockSlots[0].querySelector('[data-card-back]');

			expect(placeholder?.classList.contains('hidden')).toBe(true);
			expect(cardFace?.classList.contains('hidden')).toBe(true);
			expect(cardBack?.classList.contains('hidden')).toBe(true);
		});

		test('should set slot to placeholder state', () => {
			setSlotState(mockSlots[0], 'placeholder');

			expect(mockSlots[0].classList.contains('hidden')).toBe(false);
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('placeholder');

			const placeholder = mockSlots[0].querySelector('[data-placeholder]');
			const cardFace = mockSlots[0].querySelector('[data-card-face]');
			const cardBack = mockSlots[0].querySelector('[data-card-back]');

			expect(placeholder?.classList.contains('hidden')).toBe(false);
			expect(cardFace?.classList.contains('hidden')).toBe(true);
			expect(cardBack?.classList.contains('hidden')).toBe(true);
		});

		test('should set slot to facedown state', () => {
			setSlotState(mockSlots[0], 'facedown');

			expect(mockSlots[0].classList.contains('hidden')).toBe(false);
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('facedown');

			const placeholder = mockSlots[0].querySelector('[data-placeholder]');
			const cardFace = mockSlots[0].querySelector('[data-card-face]');
			const cardBack = mockSlots[0].querySelector('[data-card-back]');

			expect(placeholder?.classList.contains('hidden')).toBe(true);
			expect(cardFace?.classList.contains('hidden')).toBe(true);
			expect(cardBack?.classList.contains('hidden')).toBe(false);
		});

		test('should set slot to card state with red suit', () => {
			const card: CardData = { rank: 'A', suit: 'hearts' };
			setSlotState(mockSlots[0], 'card', card);

			expect(mockSlots[0].classList.contains('hidden')).toBe(false);
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('card');

			const placeholder = mockSlots[0].querySelector('[data-placeholder]');
			const cardFace = mockSlots[0].querySelector('[data-card-face]');
			const cardBack = mockSlots[0].querySelector('[data-card-back]');

			expect(placeholder?.classList.contains('hidden')).toBe(true);
			expect(cardFace?.classList.contains('hidden')).toBe(false);
			expect(cardBack?.classList.contains('hidden')).toBe(true);

			// Check card data
			expect(cardFace?.classList.contains('card-red')).toBe(true);
			expect(cardFace?.classList.contains('card-black')).toBe(false);

			const rankEls = cardFace?.querySelectorAll('[data-rank]');
			expect(rankEls?.[0]?.textContent).toBe('A');

			const suitEls = cardFace?.querySelectorAll('[data-suit-small], [data-suit-center]');
			expect(suitEls?.[0]?.textContent).toBe('♥');
		});

		test('should set slot to card state with black suit', () => {
			const card: CardData = { rank: 'K', suit: 'spades' };
			setSlotState(mockSlots[0], 'card', card);

			const cardFace = mockSlots[0].querySelector('[data-card-face]') as MockElement;
			expect(cardFace?.classList.contains('card-red')).toBe(false);
			expect(cardFace?.classList.contains('card-black')).toBe(true);

			const suitEls = cardFace?.querySelectorAll('[data-suit-small], [data-suit-center]');
			expect(suitEls?.[0]?.textContent).toBe('♠');
		});

		test('should handle unknown suit gracefully', () => {
			const card: CardData = { rank: '7', suit: 'unknown' };
			setSlotState(mockSlots[0], 'card', card);

			const cardFace = mockSlots[0].querySelector('[data-card-face]') as MockElement;
			const suitEls = cardFace?.querySelectorAll('[data-suit-small], [data-suit-center]');
			expect(suitEls?.[0]?.textContent).toBe('unknown');
		});
	});

	describe('renderCardsToContainer', () => {
		test('should render cards to container', () => {
			const cards: CardData[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: 'K', suit: 'spades' },
			];

			renderCardsToContainer('test-container', cards);

			// First two slots should show cards
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('card');
			expect(mockSlots[1].getAttribute('data-slot-state')).toBe('card');

			// Rest should be hidden
			expect(mockSlots[2].getAttribute('data-slot-state')).toBe('hidden');
			expect(mockSlots[3].getAttribute('data-slot-state')).toBe('hidden');
			expect(mockSlots[4].getAttribute('data-slot-state')).toBe('hidden');
		});

		test('should render facedown cards', () => {
			const cards: CardData[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: 'K', suit: 'spades' },
				{ rank: 'Q', suit: 'diamonds' },
			];

			renderCardsToContainer('test-container', cards, { facedownCount: 2 });

			// First card should be face up
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('card');

			// Last two should be facedown
			expect(mockSlots[1].getAttribute('data-slot-state')).toBe('facedown');
			expect(mockSlots[2].getAttribute('data-slot-state')).toBe('facedown');

			// Rest should be hidden
			expect(mockSlots[3].getAttribute('data-slot-state')).toBe('hidden');
		});

		test('should show placeholders when no cards', () => {
			renderCardsToContainer('test-container', [], { showPlaceholders: 3 });

			// First three slots should be placeholders
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[1].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[2].getAttribute('data-slot-state')).toBe('placeholder');

			// Rest should be hidden
			expect(mockSlots[3].getAttribute('data-slot-state')).toBe('hidden');
			expect(mockSlots[4].getAttribute('data-slot-state')).toBe('hidden');
		});

		test('should handle non-existent container gracefully', () => {
			expect(() => {
				renderCardsToContainer('non-existent', []);
			}).not.toThrow();
		});

		test('should use default options', () => {
			renderCardsToContainer('test-container', []);

			// Should show 2 placeholders by default
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[1].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[2].getAttribute('data-slot-state')).toBe('hidden');
		});
	});

	describe('clearCardsContainer', () => {
		test('should clear container and show placeholders', () => {
			// First render some cards
			const cards: CardData[] = [{ rank: 'A', suit: 'hearts' }];
			renderCardsToContainer('test-container', cards);

			// Then clear
			clearCardsContainer('test-container', 3);

			// Should show 3 placeholders
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[1].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[2].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[3].getAttribute('data-slot-state')).toBe('hidden');
		});

		test('should use default placeholder count', () => {
			clearCardsContainer('test-container');

			// Should show 2 placeholders by default
			expect(mockSlots[0].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[1].getAttribute('data-slot-state')).toBe('placeholder');
			expect(mockSlots[2].getAttribute('data-slot-state')).toBe('hidden');
		});
	});

	describe('setContainerHighlight', () => {
		test('should add highlight classes', () => {
			setContainerHighlight('test-container', true);

			expect(mockContainer.classList.contains('ring-2')).toBe(true);
			expect(mockContainer.classList.contains('ring-yellow-400')).toBe(true);
		});

		test('should remove highlight classes', () => {
			// First add highlight
			mockContainer.classList.add('ring-2', 'ring-yellow-400');

			// Then remove
			setContainerHighlight('test-container', false);

			expect(mockContainer.classList.contains('ring-2')).toBe(false);
			expect(mockContainer.classList.contains('ring-yellow-400')).toBe(false);
		});

		test('should handle non-existent container gracefully', () => {
			expect(() => {
				setContainerHighlight('non-existent', true);
			}).not.toThrow();
		});
	});
});
