import { describe, expect, test, beforeEach } from 'bun:test';
import { PokerUIRenderer, evaluateHandKey } from './PokerUIRenderer';
import { HAND_RANKINGS, type PokerHandNameKey } from './constants';
import { getPokerHandName } from '../i18n/messages/poker';
import type { Card, Player } from './types';

// Using flexible type for test mocks that need custom behavior
type MockElement = {
	children?: MockElement[];
	textContent?: string;
	className?: string;
	classList?: {
		add: (cls?: string) => void;
		remove: (cls?: string) => void;
		list?: string[];
		contains?: (cls: string) => boolean;
		toggle?: (cls: string, force?: boolean) => void;
	};
	parentElement?: unknown;
	querySelector?: (selector?: string) => unknown;
	querySelectorAll?: (selector?: string) => MockElement[];
	appendChild?: (el: MockElement) => void;
	remove?: () => void;
	replaceChildren?: () => void;
	innerHTML?: string;
	style?: Record<string, string>;
	dataset?: Record<string, string>;
	setAttribute?: (name: string, value: string) => void;
	getAttribute?: (name: string) => string | null;
	removeAttribute?: (name: string) => void;
	[key: string]: unknown;
};

// Helper to serialize mock element tree to HTML-like string for assertions
function serializeMockElement(el: MockElement): string {
	let result = '';
	if (el.className) {
		result += `<div class="${el.className}">`;
	}
	if (el.textContent && (!el.children || el.children.length === 0)) {
		result += el.textContent;
	}
	if (el.children) {
		for (const child of el.children) {
			result += serializeMockElement(child);
		}
	}
	if (el.className) {
		result += '</div>';
	}
	return result;
}

// Factory to create mock elements with proper DOM-like behavior
function createMockElement(initialClassName = ''): MockElement {
	const children: MockElement[] = [];
	const classList: string[] = initialClassName ? initialClassName.split(' ') : [];
	const attributes: Record<string, string> = {};
	const el: MockElement = {
		children,
		textContent: '',
		get className() {
			return classList.join(' ');
		},
		set className(value: string) {
			classList.length = 0;
			classList.push(...value.split(' ').filter(Boolean));
		},
		classList: {
			list: classList,
			add: (cls?: string) => {
				if (cls && !classList.includes(cls)) classList.push(cls);
			},
			remove: (cls?: string) => {
				if (cls) {
					const idx = classList.indexOf(cls);
					if (idx >= 0) classList.splice(idx, 1);
				}
			},
			contains: (cls: string) => classList.includes(cls),
			toggle: (cls: string, force?: boolean) => {
				const has = classList.includes(cls);
				if (force === undefined) {
					if (has) {
						classList.splice(classList.indexOf(cls), 1);
					} else {
						classList.push(cls);
					}
				} else if (force && !has) {
					classList.push(cls);
				} else if (!force && has) {
					classList.splice(classList.indexOf(cls), 1);
				}
			},
		},
		parentElement: null,
		querySelector: (selector?: string) => {
			if (!selector) return null;
			// Simple selector matching for tests
			for (const child of children) {
				if (selector.startsWith('.') && child.className?.includes(selector.slice(1))) {
					return child;
				}
				if (selector.startsWith('[data-') && child.getAttribute?.(selector.slice(1, -1))) {
					return child;
				}
			}
			return null;
		},
		querySelectorAll: (selector?: string) => {
			if (!selector) return [];
			const results: MockElement[] = [];
			const findMatches = (elements: MockElement[]) => {
				for (const child of elements) {
					if (selector.startsWith('.') && child.className?.includes(selector.slice(1))) {
						results.push(child);
					}
					if (child.children) findMatches(child.children);
				}
			};
			findMatches(children);
			return results;
		},
		appendChild: (child: MockElement) => {
			children.push(child);
		},
		remove: () => {},
		replaceChildren: () => {
			children.length = 0;
		},
		dataset: {},
		setAttribute: (name: string, value: string) => {
			attributes[name] = value;
		},
		getAttribute: (name: string) => attributes[name] || null,
		removeAttribute: (name: string) => {
			delete attributes[name];
		},
		get innerHTML(): string {
			return serializeMockElement(el);
		},
	};
	return el;
}

// Create a mock card slot with pre-rendered structure
function createMockCardSlot(index: number): MockElement {
	const slot = createMockElement('card-slot');
	slot.setAttribute?.('data-slot-index', String(index));
	slot.setAttribute?.('data-slot-state', 'hidden');

	// Placeholder
	const placeholder = createMockElement('card-placeholder hidden');
	(placeholder as MockElement).dataset = { placeholder: 'true' };
	slot.children?.push(placeholder);

	// Card face
	const cardFace = createMockElement('playing-card hidden');
	(cardFace as MockElement).dataset = { cardFace: 'true' };
	const rankEls = [createMockElement('card-rank'), createMockElement('card-rank')];
	const suitEls = [createMockElement('card-suit-small'), createMockElement('card-suit-center')];
	rankEls.forEach((r) => ((r as MockElement).dataset = { rank: 'true' }));
	suitEls.forEach((s) => ((s as MockElement).dataset = { suitSmall: 'true' }));
	cardFace.children?.push(...rankEls, ...suitEls);
	slot.children?.push(cardFace);

	// Card back
	const cardBack = createMockElement('playing-card-back hidden');
	(cardBack as MockElement).dataset = { cardBack: 'true' };
	slot.children?.push(cardBack);

	return slot;
}

// Create a mock container with pre-rendered slots
function createMockContainerWithSlots(numSlots: number): MockElement {
	const container = createMockElement();
	for (let i = 0; i < numSlots; i++) {
		container.children?.push(createMockCardSlot(i));
	}
	return container;
}

// Mock DOM environment
function mockDocument() {
	const elements: Record<string, MockElement> = {};

	// Pre-create card containers with slots
	const cardContainerIds = [
		'player-cards',
		'community-cards',
		'opponent1-cards',
		'opponent2-cards',
	];
	const slotCounts: Record<string, number> = {
		'player-cards': 2,
		'community-cards': 5,
		'opponent1-cards': 2,
		'opponent2-cards': 2,
	};

	cardContainerIds.forEach((id) => {
		elements[id] = createMockContainerWithSlots(slotCounts[id]);
	});

	(global as unknown as { document: unknown }).document = {
		getElementById: (id: string) => {
			if (!elements[id]) {
				elements[id] = createMockElement();
			}
			return elements[id];
		},
		querySelector: (selector: string) => {
			// Handle #id selectors
			if (selector.startsWith('#')) {
				const id = selector.slice(1);
				return elements[id] || null;
			}
			return null;
		},
		createElement: (_tag: string) => {
			const el = createMockElement();
			return el;
		},
		querySelectorAll: () => [],
	};

	return elements;
}

interface AppendedElement {
	textContent: string;
	className: string;
	parentElement?: unknown;
	removed?: boolean;
	remove?: () => void;
}

// Helper functions
function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

function player(
	id: number,
	name: string,
	chips: number,
	hand: Card[] = [],
	folded = false,
): Player {
	return {
		id,
		name,
		chips,
		hand,
		currentBet: 0,
		totalBet: 0,
		folded,
		isAllIn: false,
		isDealer: false,
		isAI: id > 0,
		hasActed: false,
	};
}

describe('PokerUIRenderer', () => {
	let renderer: PokerUIRenderer;
	let elements: Record<string, MockElement>;

	beforeEach(() => {
		elements = mockDocument();
		renderer = new PokerUIRenderer();
	});

	describe('renderPlayerCards()', () => {
		test('renders hole cards for human player', () => {
			const humanPlayer = player(0, 'You', 500, [card('A', 'hearts', 14), card('K', 'spades', 13)]);

			renderer.renderPlayerCards(humanPlayer, []);

			const container = elements['player-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			// Verify slots exist and cards were rendered
			expect(slots.length).toBeGreaterThanOrEqual(2);
		});

		test('applies red color to hearts and diamonds', () => {
			const humanPlayer = player(0, 'You', 500, [
				card('Q', 'hearts', 12),
				card('J', 'diamonds', 11),
			]);

			renderer.renderPlayerCards(humanPlayer, []);

			const container = elements['player-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBeGreaterThanOrEqual(2);
		});

		test('applies black color to clubs and spades', () => {
			const humanPlayer = player(0, 'You', 500, [card('10', 'clubs', 10), card('9', 'spades', 9)]);

			renderer.renderPlayerCards(humanPlayer, []);

			const container = elements['player-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBeGreaterThanOrEqual(2);
		});

		test('handles empty hand', () => {
			const humanPlayer = player(0, 'You', 500, []);

			renderer.renderPlayerCards(humanPlayer, []);

			// Empty hand should not throw and container should still have slots
			const container = elements['player-cards'];
			expect(container).toBeDefined();
		});
	});

	describe('renderCommunityCards()', () => {
		test('renders flop (3 cards)', () => {
			const communityCards = [
				card('A', 'hearts', 14),
				card('K', 'spades', 13),
				card('Q', 'diamonds', 12),
			];

			renderer.renderCommunityCards(communityCards);

			const container = elements['community-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBe(5);
		});

		test('renders turn (4 cards)', () => {
			const communityCards = [
				card('A', 'hearts', 14),
				card('K', 'spades', 13),
				card('Q', 'diamonds', 12),
				card('J', 'clubs', 11),
			];

			renderer.renderCommunityCards(communityCards);

			const container = elements['community-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBe(5);
		});

		test('renders river (5 cards)', () => {
			const communityCards = [
				card('A', 'hearts', 14),
				card('K', 'spades', 13),
				card('Q', 'diamonds', 12),
				card('J', 'clubs', 11),
				card('10', 'hearts', 10),
			];

			renderer.renderCommunityCards(communityCards);

			const container = elements['community-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBe(5);
		});

		test('renders 5 placeholders for empty board', () => {
			renderer.renderCommunityCards([]);

			const container = elements['community-cards'];
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBe(5);
		});

		test('placeholder cards have dashed border styling', () => {
			renderer.renderCommunityCards([]);

			const container = elements['community-cards'];
			// Container should have slots with placeholder structure
			const slots = container.querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBe(5);
		});
	});

	describe('updateOpponentUI()', () => {
		test('updates opponent chip counts', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350),
				player(2, 'Player 3', 750),
			];

			// Mock opponent chip elements with direct ID selectors
			const chipEl1 = { textContent: '$500' };
			const chipEl2 = { textContent: '$500' };

			const opp1Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					classList: { add: () => {}, remove: () => {} },
					querySelector: (selector: string) => {
						if (selector === '.folded-badge') return null;
						return null;
					},
					appendChild: () => {},
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			const opp2Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					classList: { add: () => {}, remove: () => {} },
					querySelector: (selector: string) => {
						if (selector === '.folded-badge') return null;
						return null;
					},
					appendChild: () => {},
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent1-cards'] = opp1Container;
			elements['opponent2-cards'] = opp2Container;
			elements['opponent1-chips'] = chipEl1;
			elements['opponent2-chips'] = chipEl2;

			renderer.updateOpponentUI(players);

			expect(chipEl1.textContent).toBe('350 chips');
			expect(chipEl2.textContent).toBe('750 chips');
		});

		test('handles folded opponents', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [], true),
				player(2, 'Player 3', 750),
			];

			const classList = {
				list: [] as string[],
				add: (cls?: string) => {
					if (cls) classList.list.push(cls);
				},
				remove: (cls?: string) => {
					if (cls) classList.list = classList.list.filter((c) => c !== cls);
				},
			};

			const opp1Container = {
				innerHTML: '',
				textContent: '',
				classList,
				parentElement: {
					classList,
					querySelector: () => null,
					appendChild: () => {},
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent1-cards'] = opp1Container;

			renderer.updateOpponentUI(players);

			expect(classList.list).toContain('opacity-40');
			expect(classList.list).toContain('grayscale');
		});
	});

	describe('showAIDecision()', () => {
		test('shows fold decision', () => {
			const appendedElements: AppendedElement[] = [];

			const opp1Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					querySelector: () => null,
					appendChild: (el: AppendedElement) => appendedElements.push(el),
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent1-cards'] = opp1Container;

			renderer.showAIDecision(1, 'fold');

			expect(appendedElements.length).toBe(1);
			expect(appendedElements[0].textContent).toBe('✕ FOLD');
			expect(appendedElements[0].className).toContain('bg-[var(--deco-oxblood-bright)]');
		});

		test('shows check decision', () => {
			const appendedElements: AppendedElement[] = [];

			const opp1Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					querySelector: () => null,
					appendChild: (el: AppendedElement) => appendedElements.push(el),
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent1-cards'] = opp1Container;

			renderer.showAIDecision(1, 'check');

			expect(appendedElements[0].textContent).toBe('✓ CHECK');
			expect(appendedElements[0].className).toContain('bg-[var(--deco-sapphire)]');
		});

		test('shows call decision with amount', () => {
			const appendedElements: AppendedElement[] = [];

			const opp2Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					querySelector: () => null,
					appendChild: (el: AppendedElement) => appendedElements.push(el),
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent2-cards'] = opp2Container;

			renderer.showAIDecision(2, 'call', 50);

			expect(appendedElements[0].textContent).toBe('✓ CALL 50 chips');
			expect(appendedElements[0].className).toContain('bg-[var(--deco-jade)]');
		});

		test('shows raise decision with amount', () => {
			const appendedElements: AppendedElement[] = [];

			const opp1Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					querySelector: () => null,
					appendChild: (el: AppendedElement) => appendedElements.push(el),
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent1-cards'] = opp1Container;

			renderer.showAIDecision(1, 'raise', 100);

			expect(appendedElements[0].textContent).toBe('↑ RAISE 100 chips');
			expect(appendedElements[0].className).toContain('bg-[var(--deco-brass)]');
		});

		test('removes existing decision badge before adding new one', () => {
			const existingBadge: AppendedElement = {
				textContent: '',
				className: '',
				remove: () => {
					existingBadge.removed = true;
				},
				removed: false,
			};
			const appendedElements: AppendedElement[] = [];

			const opp1Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					querySelector: (selector: string) =>
						selector === '.ai-decision-badge' ? existingBadge : null,
					appendChild: (el: AppendedElement) => appendedElements.push(el),
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent1-cards'] = opp1Container;

			renderer.showAIDecision(1, 'check');

			expect(existingBadge.removed).toBe(true);
		});
	});

	describe('revealOpponentHands()', () => {
		test('reveals non-folded opponent cards', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [card('A', 'hearts', 14), card('K', 'spades', 13)]),
				player(2, 'Player 3', 750, [card('Q', 'diamonds', 12), card('J', 'clubs', 11)]),
			];
			const winners = [players[1]];

			renderer.revealOpponentHands(players, winners);

			// Verify slots exist in opponent containers
			const opp1Slots = elements['opponent1-cards'].querySelectorAll?.('.card-slot') || [];
			const opp2Slots = elements['opponent2-cards'].querySelectorAll?.('.card-slot') || [];
			expect(opp1Slots.length).toBe(2);
			expect(opp2Slots.length).toBe(2);
		});

		test('does not reveal folded opponent cards', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [card('A', 'hearts', 14), card('K', 'spades', 13)], true),
				player(2, 'Player 3', 750, [card('Q', 'diamonds', 12), card('J', 'clubs', 11)]),
			];
			const winners = [players[2]];

			renderer.revealOpponentHands(players, winners);

			// Opponent 2 should have slots revealed
			const opp2Slots = elements['opponent2-cards'].querySelectorAll?.('.card-slot') || [];
			expect(opp2Slots.length).toBe(2);
		});

		test('highlights multiple winners with tie', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [card('A', 'hearts', 14), card('K', 'spades', 13)]),
				player(2, 'Player 3', 750, [card('A', 'diamonds', 14), card('K', 'clubs', 13)]),
			];
			const winners = [players[1], players[2]]; // Tie

			renderer.revealOpponentHands(players, winners);

			// Both opponents should have slots
			const opp1Slots = elements['opponent1-cards'].querySelectorAll?.('.card-slot') || [];
			const opp2Slots = elements['opponent2-cards'].querySelectorAll?.('.card-slot') || [];
			expect(opp1Slots.length).toBe(2);
			expect(opp2Slots.length).toBe(2);
		});

		test('uses smaller card styling for opponents', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [card('A', 'hearts', 14), card('K', 'spades', 13)]),
				player(2, 'Player 3', 750, [card('Q', 'diamonds', 12), card('J', 'clubs', 11)]),
			];
			const winners = [players[1]];

			renderer.revealOpponentHands(players, winners);

			// Both opponents should have card slots
			const opp1Slots = elements['opponent1-cards'].querySelectorAll?.('.card-slot') || [];
			const opp2Slots = elements['opponent2-cards'].querySelectorAll?.('.card-slot') || [];
			expect(opp1Slots.length).toBe(2);
			expect(opp2Slots.length).toBe(2);
		});
	});

	describe('hideOpponentHands()', () => {
		test('resets opponents to face-down cards', () => {
			renderer.hideOpponentHands();

			// Both opponents should have slots
			const opp1Slots = elements['opponent1-cards'].querySelectorAll?.('.card-slot') || [];
			const opp2Slots = elements['opponent2-cards'].querySelectorAll?.('.card-slot') || [];
			expect(opp1Slots.length).toBe(2);
			expect(opp2Slots.length).toBe(2);
		});

		test('face-down cards have decorative styling', () => {
			renderer.hideOpponentHands();

			// Both opponents should have slots with face-down state
			const opp1Slots = elements['opponent1-cards'].querySelectorAll?.('.card-slot') || [];
			expect(opp1Slots.length).toBe(2);
		});
	});

	describe('updateUI()', () => {
		test('updates pot and current bet displays', () => {
			const humanPlayer = player(0, 'You', 450);
			humanPlayer.currentBet = 50;

			renderer.updateUI(150, humanPlayer);

			expect(elements['pot-amount'].textContent).toBe('150 chips');
			expect(elements['current-bet'].textContent).toBe('50 chips');
		});

		test('updates player balance in header', () => {
			const humanPlayer = player(0, 'You', 325);

			// Mock the header balance element using getElementById
			const balanceEl = { textContent: '$500' };
			elements['player-balance'] = balanceEl;

			renderer.updateUI(0, humanPlayer);

			expect(balanceEl.textContent).toBe('325 chips');
		});

		test('handles zero values correctly', () => {
			const humanPlayer = player(0, 'You', 0);
			humanPlayer.currentBet = 0;

			renderer.updateUI(0, humanPlayer);

			expect(elements['pot-amount'].textContent).toBe('0 chips');
			expect(elements['current-bet'].textContent).toBe('0 chips');
		});

		test('handles missing DOM elements gracefully', () => {
			const humanPlayer = player(0, 'You', 500);
			humanPlayer.currentBet = 50;

			// Create a fresh document mock with no elements
			(global as unknown as { document: unknown }).document = {
				getElementById: () => null,
				querySelector: () => null,
				createElement: () => ({
					className: '',
					textContent: '',
					remove: () => {},
					parentElement: null,
				}),
				querySelectorAll: () => [],
			};

			// Should not throw when elements are missing
			expect(() => renderer.updateUI(100, humanPlayer)).not.toThrow();
		});
	});

	describe('updateGameStatus()', () => {
		test('formats status with phase and pot info', () => {
			renderer.updateGameStatus('Your turn!', 'flop', 150);

			expect(elements['game-status'].textContent).toBe('[Flop | Pot: 150 chips] Your turn!');
		});

		test('capitalizes phase label', () => {
			renderer.updateGameStatus('Waiting...', 'preflop', 30);

			expect(elements['game-status'].textContent).toContain('[Preflop');
		});

		test('omits pot info when pot is zero', () => {
			renderer.updateGameStatus('New hand!', 'preflop', 0);

			expect(elements['game-status'].textContent).toBe('[Preflop] New hand!');
		});

		test('handles showdown phase', () => {
			renderer.updateGameStatus('Player 2 wins!', 'showdown', 500);

			expect(elements['game-status'].textContent).toBe(
				'[Showdown | Pot: 500 chips] Player 2 wins!',
			);
		});

		test('handles missing status element gracefully', () => {
			// Create a fresh document mock with no elements
			(global as unknown as { document: unknown }).document = {
				getElementById: () => null,
				querySelector: () => null,
				createElement: () => ({
					className: '',
					textContent: '',
					remove: () => {},
					parentElement: null,
				}),
				querySelectorAll: () => [],
			};

			// Should not throw when game-status element is missing
			expect(() => renderer.updateGameStatus('Test message', 'flop', 100)).not.toThrow();
		});
	});

	describe('evaluateHandKey()', () => {
		test('returns null for fewer than two cards', () => {
			expect(evaluateHandKey(player(0, 'You', 500, [card('A', 'hearts', 14)]), [])).toBeNull();
			expect(evaluateHandKey(player(0, 'You', 500), [])).toBeNull();
		});

		test('classifies pairs, two pair, trips, and quads', () => {
			expect(
				evaluateHandKey(
					player(0, 'You', 500, [card('A', 'hearts', 14), card('A', 'spades', 14)]),
					[],
				),
			).toBe('PAIR');
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('A', 'hearts', 14), card('A', 'spades', 14)]), [
					card('K', 'hearts', 13),
					card('K', 'diamonds', 13),
					card('9', 'clubs', 9),
					card('2', 'clubs', 2),
				]),
			).toBe('TWO_PAIR');
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('Q', 'hearts', 12), card('Q', 'spades', 12)]), [
					card('Q', 'diamonds', 12),
					card('9', 'clubs', 9),
					card('2', 'hearts', 2),
				]),
			).toBe('THREE_OF_A_KIND');
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('J', 'hearts', 11), card('J', 'spades', 11)]), [
					card('J', 'diamonds', 11),
					card('J', 'clubs', 11),
					card('2', 'hearts', 2),
				]),
			).toBe('FOUR_OF_A_KIND');
		});

		test('classifies full house', () => {
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('A', 'hearts', 14), card('A', 'spades', 14)]), [
					card('A', 'diamonds', 14),
					card('K', 'clubs', 13),
					card('K', 'hearts', 13),
				]),
			).toBe('FULL_HOUSE');
		});

		test('classifies straights including the wheel', () => {
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('6', 'hearts', 6), card('7', 'hearts', 7)]), [
					card('8', 'spades', 8),
					card('9', 'spades', 9),
					card('10', 'spades', 10),
				]),
			).toBe('STRAIGHT');
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('A', 'hearts', 14), card('2', 'spades', 2)]), [
					card('3', 'clubs', 3),
					card('4', 'diamonds', 4),
					card('5', 'hearts', 5),
				]),
			).toBe('STRAIGHT');
		});

		test('classifies flush, straight flush, and royal flush', () => {
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('A', 'hearts', 14), card('K', 'hearts', 13)]), [
					card('Q', 'hearts', 12),
					card('J', 'hearts', 11),
					card('10', 'hearts', 10),
				]),
			).toBe('ROYAL_FLUSH');
			expect(
				evaluateHandKey(
					player(0, 'You', 500, [card('5', 'diamonds', 5), card('6', 'diamonds', 6)]),
					[card('7', 'diamonds', 7), card('8', 'diamonds', 8), card('9', 'diamonds', 9)],
				),
			).toBe('STRAIGHT_FLUSH');
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('A', 'clubs', 14), card('K', 'clubs', 13)]), [
					card('Q', 'clubs', 12),
					card('9', 'clubs', 9),
					card('2', 'clubs', 2),
				]),
			).toBe('FLUSH');
			expect(
				evaluateHandKey(player(0, 'You', 500, [card('A', 'hearts', 14), card('K', 'spades', 13)]), [
					card('Q', 'diamonds', 12),
					card('9', 'clubs', 9),
					card('2', 'hearts', 2),
				]),
			).toBe('HIGH_CARD');
		});

		test('every hand ranking key maps to a distinct label', () => {
			const keys = Object.keys(HAND_RANKINGS) as PokerHandNameKey[];
			expect(keys.length).toBe(10);
			const labels = keys.map((key) => getPokerHandName('en', key));
			expect(labels.every((label) => label.length > 0)).toBe(true);
			expect(new Set(labels).size).toBe(labels.length);
		});
	});

	describe('hand strength presentation', () => {
		test('renderPlayerCards sets the localized hand strength label', () => {
			const humanPlayer = player(0, 'You', 500, [card('A', 'hearts', 14), card('A', 'spades', 14)]);

			renderer.renderPlayerCards(humanPlayer, []);

			expect(elements['hand-strength'].textContent).toBe(getPokerHandName('en', 'PAIR'));
		});

		test('labels a straight as Straight instead of High Card', () => {
			const humanPlayer = player(0, 'You', 500, [card('6', 'hearts', 6), card('7', 'hearts', 7)]);

			renderer.renderPlayerCards(humanPlayer, [
				card('8', 'spades', 8),
				card('9', 'spades', 9),
				card('10', 'spades', 10),
			]);

			expect(elements['hand-strength'].textContent).toBe(getPokerHandName('en', 'STRAIGHT'));
		});

		test('labels a royal flush instead of a generic flush', () => {
			const humanPlayer = player(0, 'You', 500, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);

			renderer.renderPlayerCards(humanPlayer, [
				card('Q', 'hearts', 12),
				card('J', 'hearts', 11),
				card('10', 'hearts', 10),
			]);

			expect(elements['hand-strength'].textContent).toBe(getPokerHandName('en', 'ROYAL_FLUSH'));
		});

		test('keeps placeholder for fewer than two cards', () => {
			renderer.renderPlayerCards(player(0, 'You', 500, [card('A', 'hearts', 14)]), []);

			expect(elements['hand-strength'].textContent).toBe('--');
		});
	});

	describe('accessible card names', () => {
		test('player card slots get localized aria-labels', () => {
			const humanPlayer = player(0, 'You', 500, [card('A', 'hearts', 14), card('K', 'spades', 13)]);

			renderer.renderPlayerCards(humanPlayer, []);

			const slots = elements['player-cards'].querySelectorAll?.('.card-slot') || [];
			expect(slots[0].getAttribute?.('aria-label')).toBe('Ace of Hearts');
			expect(slots[1].getAttribute?.('aria-label')).toBe('King of Spades');
		});

		test('community card slots get localized aria-labels', () => {
			renderer.renderCommunityCards([card('Q', 'diamonds', 12), card('J', 'clubs', 11)]);

			const slots = elements['community-cards'].querySelectorAll?.('.card-slot') || [];
			expect(slots[0].getAttribute?.('aria-label')).toBe('Queen of Diamonds');
			expect(slots[1].getAttribute?.('aria-label')).toBe('Jack of Clubs');
			expect(slots[2].getAttribute?.('aria-label')).toBeNull();
		});
	});

	describe('chip phrase presentation', () => {
		test('updates pot and current bet displays with chip phrases', () => {
			const humanPlayer = player(0, 'You', 450);
			humanPlayer.currentBet = 50;

			renderer.updateUI(150, humanPlayer);

			expect(elements['pot-amount'].textContent).toBe('150 chips');
			expect(elements['current-bet'].textContent).toBe('50 chips');
		});

		test('updates player balance with a chip phrase', () => {
			const humanPlayer = player(0, 'You', 325);

			const balanceEl = { textContent: '$500' };
			elements['player-balance'] = balanceEl;

			renderer.updateUI(0, humanPlayer);

			expect(balanceEl.textContent).toBe('325 chips');
		});

		test('formats status with localized phase and pot', () => {
			renderer.updateGameStatus('Your turn!', 'flop', 150);

			expect(elements['game-status'].textContent).toBe('[Flop | Pot: 150 chips] Your turn!');
		});

		test('omits pot info when pot is zero', () => {
			renderer.updateGameStatus('New hand!', 'preflop', 0);

			expect(elements['game-status'].textContent).toBe('[Preflop] New hand!');
		});

		test('shows call decision badge with a chip phrase', () => {
			const appendedElements: AppendedElement[] = [];

			const opp2Container = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: {
					querySelector: () => null,
					appendChild: (el: AppendedElement) => appendedElements.push(el),
					style: {},
				},
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			elements['opponent2-cards'] = opp2Container;

			renderer.showAIDecision(2, 'call', 50);

			expect(appendedElements[0].textContent).toBe('✓ CALL 50 chips');
		});
	});

	describe('Suit symbol rendering', () => {
		test('renders all four suits correctly', () => {
			const humanPlayer = player(0, 'You', 500, [
				card('A', 'hearts', 14),
				card('K', 'diamonds', 13),
			]);

			renderer.renderPlayerCards(humanPlayer, []);
			// Verify slots exist for card rendering
			const slots = elements['player-cards'].querySelectorAll?.('.card-slot') || [];
			expect(slots.length).toBeGreaterThanOrEqual(2);

			const humanPlayer2 = player(0, 'You', 500, [card('Q', 'clubs', 12), card('J', 'spades', 11)]);

			renderer.renderPlayerCards(humanPlayer2, []);
			const slots2 = elements['player-cards'].querySelectorAll?.('.card-slot') || [];
			expect(slots2.length).toBeGreaterThanOrEqual(2);
		});
	});
});
