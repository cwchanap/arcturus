import { describe, expect, test, beforeEach } from 'bun:test';
import { PokerUIRenderer } from './PokerUIRenderer';
import type { Card, Player } from './types';

interface MockElement {
	innerHTML: string;
	textContent: string;
	classList: { add: (cls?: string) => void; remove: (cls?: string) => void };
	parentElement: unknown;
	querySelector: () => unknown;
	appendChild: (_el: unknown) => void;
	remove: () => void;
}

// Mock DOM environment
function mockDocument() {
	const elements: Record<string, MockElement> = {};

	(global as unknown as { document: unknown }).document = {
		getElementById: (id: string) => {
			if (!elements[id]) {
				const el: MockElement = {
					innerHTML: '',
					textContent: '',
					classList: {
						add: () => {},
						remove: () => {},
					},
					parentElement: null,
					querySelector: () => null,
					appendChild: () => {},
					remove: () => {},
				};
				elements[id] = el;
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
		createElement: () => ({
			className: '',
			textContent: '',
			remove: () => {},
			parentElement: null,
		}),
		querySelectorAll: () => [],
	};

	return elements;
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
			expect(container.innerHTML).toContain('A');
			expect(container.innerHTML).toContain('K');
			expect(container.innerHTML).toContain('♥');
			expect(container.innerHTML).toContain('♠');
		});

		test('applies red color to hearts and diamonds', () => {
			const humanPlayer = player(0, 'You', 500, [
				card('Q', 'hearts', 12),
				card('J', 'diamonds', 11),
			]);

			renderer.renderPlayerCards(humanPlayer, []);

			const html = elements['player-cards'].innerHTML;
			expect(html).toContain('text-red-600');
			expect(html).toContain('♥');
			expect(html).toContain('♦');
		});

		test('applies black color to clubs and spades', () => {
			const humanPlayer = player(0, 'You', 500, [card('10', 'clubs', 10), card('9', 'spades', 9)]);

			renderer.renderPlayerCards(humanPlayer, []);

			const html = elements['player-cards'].innerHTML;
			expect(html).toContain('text-gray-900');
			expect(html).toContain('♣');
			expect(html).toContain('♠');
		});

		test('handles empty hand', () => {
			const humanPlayer = player(0, 'You', 500, []);

			renderer.renderPlayerCards(humanPlayer, []);

			expect(elements['player-cards'].innerHTML).toBe('');
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

			const html = elements['community-cards'].innerHTML;
			expect(html).toContain('A');
			expect(html).toContain('K');
			expect(html).toContain('Q');
			// Should show 2 placeholder cards
			expect(html.match(/\?/g)?.length).toBe(2);
		});

		test('renders turn (4 cards)', () => {
			const communityCards = [
				card('A', 'hearts', 14),
				card('K', 'spades', 13),
				card('Q', 'diamonds', 12),
				card('J', 'clubs', 11),
			];

			renderer.renderCommunityCards(communityCards);

			const html = elements['community-cards'].innerHTML;
			expect(html).toContain('J');
			expect(html.match(/\?/g)?.length).toBe(1);
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

			const html = elements['community-cards'].innerHTML;
			expect(html).toContain('10');
			expect(html).not.toContain('?');
		});

		test('renders 5 placeholders for empty board', () => {
			renderer.renderCommunityCards([]);

			const html = elements['community-cards'].innerHTML;
			expect(html.match(/\?/g)?.length).toBe(5);
		});

		test('placeholder cards have dashed border styling', () => {
			renderer.renderCommunityCards([]);

			const html = elements['community-cards'].innerHTML;
			expect(html).toContain('border-dashed');
			expect(html).toContain('bg-slate-800/50');
		});
	});

	describe('updateOpponentUI()', () => {
		test('updates opponent chip counts', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350),
				player(2, 'Player 3', 750),
			];

			// Mock opponent containers with chip displays
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
						if (selector === '.text-xs.text-yellow-400') return chipEl1;
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
						if (selector === '.text-xs.text-yellow-400') return chipEl2;
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

			renderer.updateOpponentUI(players);

			expect(chipEl1.textContent).toBe('$350');
			expect(chipEl2.textContent).toBe('$750');
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

	interface AppendedElement {
		textContent: string;
		className: string;
		parentElement?: unknown;
		removed?: boolean;
		remove?: () => void;
	}

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
			expect(appendedElements[0].className).toContain('bg-red-600');
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
			expect(appendedElements[0].className).toContain('bg-blue-600');
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

			expect(appendedElements[0].textContent).toBe('✓ CALL $50');
			expect(appendedElements[0].className).toContain('bg-green-600');
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

			expect(appendedElements[0].textContent).toBe('↑ RAISE $100');
			expect(appendedElements[0].className).toContain('bg-yellow-600');
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

			const opp1Html = elements['opponent1-cards'].innerHTML;
			expect(opp1Html).toContain('A');
			expect(opp1Html).toContain('K');
			expect(opp1Html).toContain('ring-2 ring-yellow-400'); // Winner highlight

			const opp2Html = elements['opponent2-cards'].innerHTML;
			expect(opp2Html).toContain('Q');
			expect(opp2Html).toContain('J');
			expect(opp2Html).not.toContain('ring-2'); // Not winner
		});

		test('does not reveal folded opponent cards', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [card('A', 'hearts', 14), card('K', 'spades', 13)], true),
				player(2, 'Player 3', 750, [card('Q', 'diamonds', 12), card('J', 'clubs', 11)]),
			];
			const winners = [players[2]];

			// Ensure opponent1-cards container exists
			elements['opponent1-cards'] = {
				innerHTML: '',
				textContent: '',
				classList: { add: () => {}, remove: () => {} },
				parentElement: null,
				querySelector: () => null,
				appendChild: () => {},
				remove: () => {},
			};

			renderer.revealOpponentHands(players, winners);

			// Opponent 1 is folded, should not update innerHTML
			expect(elements['opponent1-cards'].innerHTML).toBe('');

			// Opponent 2 should reveal
			const opp2Html = elements['opponent2-cards'].innerHTML;
			expect(opp2Html).toContain('Q');
		});

		test('highlights multiple winners with tie', () => {
			const players = [
				player(0, 'You', 500),
				player(1, 'Player 2', 350, [card('A', 'hearts', 14), card('K', 'spades', 13)]),
				player(2, 'Player 3', 750, [card('A', 'diamonds', 14), card('K', 'clubs', 13)]),
			];
			const winners = [players[1], players[2]]; // Tie

			renderer.revealOpponentHands(players, winners);

			expect(elements['opponent1-cards'].innerHTML).toContain('ring-2 ring-yellow-400');
			expect(elements['opponent2-cards'].innerHTML).toContain('ring-2 ring-yellow-400');
		});
	});

	describe('hideOpponentHands()', () => {
		test('resets opponents to face-down cards', () => {
			renderer.hideOpponentHands();

			const opp1Html = elements['opponent1-cards'].innerHTML;
			const opp2Html = elements['opponent2-cards'].innerHTML;

			expect(opp1Html).toContain('card-back');
			expect(opp1Html).toContain('🂠');
			expect(opp2Html).toContain('card-back');
			expect(opp2Html).toContain('🂠');
		});

		test('face-down cards have decorative styling', () => {
			renderer.hideOpponentHands();

			const html = elements['opponent1-cards'].innerHTML;
			expect(html).toContain('bg-gradient-to-br');
			expect(html).toContain('from-blue-900');
			expect(html).toContain('to-purple-900');
			expect(html).toContain('border-yellow-500/30');
		});
	});

	describe('updateUI()', () => {
		test('updates pot and current bet displays', () => {
			const humanPlayer = player(0, 'You', 450);
			humanPlayer.currentBet = 50;

			renderer.updateUI(150, humanPlayer);

			expect(elements['pot-amount'].textContent).toBe('$150');
			expect(elements['current-bet'].textContent).toBe('$50');
		});

		test('updates player balance in header', () => {
			const humanPlayer = player(0, 'You', 325);

			// Mock the header balance element
			const balanceEl = { textContent: '$500' };
			(global as unknown as { document: { querySelector: () => unknown } }).document.querySelector =
				() => balanceEl;

			renderer.updateUI(0, humanPlayer);

			expect(balanceEl.textContent).toBe('$325');
		});

		test('handles zero values correctly', () => {
			const humanPlayer = player(0, 'You', 0);
			humanPlayer.currentBet = 0;

			renderer.updateUI(0, humanPlayer);

			expect(elements['pot-amount'].textContent).toBe('$0');
			expect(elements['current-bet'].textContent).toBe('$0');
		});
	});

	describe('updateGameStatus()', () => {
		test('formats status with phase and pot info', () => {
			renderer.updateGameStatus('Your turn!', 'flop', 150);

			expect(elements['game-status'].textContent).toBe('[Flop | Pot: $150] Your turn!');
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

			expect(elements['game-status'].textContent).toBe('[Showdown | Pot: $500] Player 2 wins!');
		});
	});

	describe('Suit symbol rendering', () => {
		test('renders all four suits correctly', () => {
			const humanPlayer = player(0, 'You', 500, [
				card('A', 'hearts', 14),
				card('K', 'diamonds', 13),
			]);

			renderer.renderPlayerCards(humanPlayer, []);
			const heartsHtml = elements['player-cards'].innerHTML;

			const humanPlayer2 = player(0, 'You', 500, [card('Q', 'clubs', 12), card('J', 'spades', 11)]);

			renderer.renderPlayerCards(humanPlayer2, []);
			const clubsHtml = elements['player-cards'].innerHTML;

			expect(heartsHtml).toContain('♥');
			expect(heartsHtml).toContain('♦');
			expect(clubsHtml).toContain('♣');
			expect(clubsHtml).toContain('♠');
		});
	});
});
