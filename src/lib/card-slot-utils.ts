/**
 * Card Slot Utilities
 * Handles card display by toggling visibility of pre-rendered elements
 * NO DOM element creation - only visibility toggling and text updates
 */

const SUIT_SYMBOLS: Record<string, string> = {
	hearts: '♥',
	diamonds: '♦',
	clubs: '♣',
	spades: '♠',
};

const RED_SUITS = new Set(['hearts', 'diamonds']);

export interface CardData {
	rank: string;
	suit: string;
}

type SlotState = 'hidden' | 'placeholder' | 'card' | 'facedown';

/**
 * Update a card slot to show a specific state
 */
export function setSlotState(slot: Element, state: SlotState, card?: CardData): void {
	const placeholder = slot.querySelector('[data-placeholder]');
	const cardFace = slot.querySelector('[data-card-face]');
	const cardBack = slot.querySelector('[data-card-back]');

	// Hide all first
	placeholder?.classList.add('hidden');
	cardFace?.classList.add('hidden');
	cardBack?.classList.add('hidden');

	slot.setAttribute('data-slot-state', state);

	switch (state) {
		case 'placeholder':
			placeholder?.classList.remove('hidden');
			break;
		case 'card':
			if (card && cardFace) {
				updateCardFace(cardFace, card);
				cardFace.classList.remove('hidden');
			}
			break;
		case 'facedown':
			cardBack?.classList.remove('hidden');
			break;
		case 'hidden':
		default:
			// All elements stay hidden
			break;
	}
}

/**
 * Update card face elements with card data
 */
function updateCardFace(cardFace: Element, card: CardData): void {
	const suitSymbol = SUIT_SYMBOLS[card.suit] || card.suit;
	const isRed = RED_SUITS.has(card.suit);
	const colorClass = isRed ? 'card-red' : 'card-black';

	// Update rank elements
	cardFace.querySelectorAll('[data-rank]').forEach((el) => {
		el.textContent = card.rank;
	});

	// Update suit elements
	cardFace.querySelectorAll('[data-suit-small], [data-suit-center]').forEach((el) => {
		el.textContent = suitSymbol;
	});

	// Update color class
	cardFace.classList.remove('card-red', 'card-black');
	cardFace.classList.add(colorClass);
}

/**
 * Render cards to a container with pre-rendered slots
 */
export function renderCardsToContainer(
	containerId: string,
	cards: CardData[],
	options: { showPlaceholders?: number; facedownCount?: number } = {},
): void {
	const container = document.getElementById(containerId);
	if (!container) return;

	const slots = container.querySelectorAll('.card-slot');
	const { showPlaceholders = 2, facedownCount = 0 } = options;

	slots.forEach((slot, index) => {
		if (index < cards.length) {
			// Show card (face-down if in facedownCount range from end)
			const isFacedown = facedownCount > 0 && index >= cards.length - facedownCount;
			if (isFacedown) {
				setSlotState(slot, 'facedown');
			} else {
				setSlotState(slot, 'card', cards[index]);
			}
		} else if (cards.length === 0 && index < showPlaceholders) {
			// Show placeholder when no cards
			setSlotState(slot, 'placeholder');
		} else {
			// Hide unused slots
			setSlotState(slot, 'hidden');
		}
	});
}

/**
 * Clear all cards from a container (show placeholders)
 */
export function clearCardsContainer(containerId: string, placeholderCount = 2): void {
	renderCardsToContainer(containerId, [], { showPlaceholders: placeholderCount });
}

/**
 * Add highlight class to container (for winner indication)
 */
export function setContainerHighlight(containerId: string, highlight: boolean): void {
	const container = document.getElementById(containerId);
	if (!container) return;

	if (highlight) {
		container.classList.add('ring-2', 'ring-yellow-400');
	} else {
		container.classList.remove('ring-2', 'ring-yellow-400');
	}
}
