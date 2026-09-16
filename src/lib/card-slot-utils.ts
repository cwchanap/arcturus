/**
 * Card Slot Utilities
 * Handles card display by toggling visibility of pre-rendered elements
 * Detailed card faces also render suit pips when their markup opts in.
 */

import { getSuitSymbol, isRedSuit } from './card-format';

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

	// Ensure slot visibility matches state
	slot.classList.toggle('hidden', state === 'hidden');

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
	const suitSymbol = getSuitSymbol(card.suit);
	const colorClass = isRedSuit(card.suit) ? 'card-red' : 'card-black';

	// Update rank elements
	cardFace.querySelectorAll('[data-rank]').forEach((el) => {
		el.textContent = card.rank;
	});

	// Update suit elements
	cardFace.querySelectorAll('[data-suit-small], [data-suit-center]').forEach((el) => {
		el.textContent = suitSymbol;
	});

	// Detailed pip layout is shared by the Poker and Blackjack cabinets.
	const detail = cardFace.querySelector<HTMLElement>('[data-card-detail]');
	if (detail) {
		detail.replaceChildren();
		const face = cardFace.querySelector<HTMLElement>('[data-face-detail]');
		face?.classList.toggle('hidden', Number(card.rank) >= 2 && Number(card.rank) <= 10);
		const positions: Record<number, number[][]> = {
			2: [
				[50, 0],
				[50, 100],
			],
			3: [
				[50, 0],
				[50, 50],
				[50, 100],
			],
			4: [
				[0, 0],
				[100, 0],
				[0, 100],
				[100, 100],
			],
			5: [
				[0, 0],
				[100, 0],
				[50, 50],
				[0, 100],
				[100, 100],
			],
			6: [
				[0, 0],
				[100, 0],
				[0, 50],
				[100, 50],
				[0, 100],
				[100, 100],
			],
			7: [
				[0, 0],
				[100, 0],
				[50, 25],
				[0, 50],
				[100, 50],
				[0, 100],
				[100, 100],
			],
			8: [
				[0, 0],
				[100, 0],
				[50, 25],
				[0, 50],
				[100, 50],
				[50, 75],
				[0, 100],
				[100, 100],
			],
			9: [
				[0, 0],
				[100, 0],
				[0, 33],
				[100, 33],
				[50, 50],
				[0, 67],
				[100, 67],
				[0, 100],
				[100, 100],
			],
			10: [
				[0, 0],
				[100, 0],
				[50, 20],
				[0, 33],
				[100, 33],
				[0, 67],
				[100, 67],
				[50, 80],
				[0, 100],
				[100, 100],
			],
		};
		for (const [x, y] of positions[Number(card.rank)] ?? []) {
			const pip = cardFace.ownerDocument.createElement('span');
			pip.textContent = suitSymbol;
			pip.style.left = `${x}%`;
			pip.style.top = `${y}%`;
			detail.appendChild(pip);
		}
	}

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
