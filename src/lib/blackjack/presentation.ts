import { getSuitSymbol, isRedSuit } from '../card-format';
import type { Card, HandValue } from './types';

export interface BlackjackPresentationOptions {
	readonly testIdPrefix: string;
	readonly formatWager: (value: number) => string;
}

export interface BlackjackDealerProjection {
	readonly cards: readonly Card[];
	readonly value: HandValue;
}

export interface BlackjackPlayerHandProjection {
	readonly cards: readonly Card[];
	readonly wager: number;
	readonly value: HandValue;
}

const CARD_BASE_CLASS =
	'playing-card flex h-24 w-16 flex-col items-center justify-center rounded-lg bg-white text-xl font-bold shadow-lg';
const ACTIVE_HAND_CLASS = 'rounded-xl border-2 border-[var(--deco-brass)] p-4';
const INACTIVE_HAND_CLASS = 'rounded-xl border border-[var(--deco-line)] p-4';
const HAND_CARDS_CLASS = 'flex flex-wrap justify-center gap-2';
const HAND_LABEL_CLASS = 'mb-2 text-sm text-[var(--deco-muted)]';
const HAND_VALUE_CLASS = 'mb-3 font-bold text-[var(--deco-brass)]';

export function formatBlackjackHandValue(value: HandValue): string {
	if (value.isBust) return `Bust ${value.value}`;
	if (value.isSoft) return `Soft ${value.value}`;
	return String(value.value);
}

export function createBlackjackCardElement(
	document: Document,
	card: Card,
	testId: string,
): HTMLElement {
	const element = document.createElement('div');
	element.dataset.testid = testId;
	element.className = CARD_BASE_CLASS;
	element.classList.add(isRedSuit(card.suit) ? 'text-red-700' : 'text-slate-900');
	element.setAttribute('aria-label', `${card.rank} of ${card.suit}`);
	element.textContent = `${card.rank}${getSuitSymbol(card.suit)}`;
	return element;
}

export function renderBlackjackDealer(
	document: Document,
	dealerHandContainer: HTMLElement,
	dealerValueContainer: HTMLElement,
	dealer: BlackjackDealerProjection,
	options: Pick<BlackjackPresentationOptions, 'testIdPrefix'>,
): void {
	dealerHandContainer.replaceChildren(
		...dealer.cards.map((card) =>
			createBlackjackCardElement(document, card, `${options.testIdPrefix}-dealer-card`),
		),
	);
	dealerValueContainer.textContent = formatBlackjackHandValue(dealer.value);
}

export function renderBlackjackPlayerHands(
	document: Document,
	playerHandsContainer: HTMLElement,
	hands: readonly BlackjackPlayerHandProjection[],
	activeHandIndex: number,
	options: BlackjackPresentationOptions,
): void {
	const rendered = hands.map((hand, index) => {
		const isActive = index === activeHandIndex;
		const section = document.createElement('section');
		section.dataset.testid = `${options.testIdPrefix}-player-hand`;
		section.dataset.active = String(isActive);
		section.className = isActive ? ACTIVE_HAND_CLASS : INACTIVE_HAND_CLASS;

		const label = document.createElement('p');
		label.className = HAND_LABEL_CLASS;
		label.textContent = `Hand ${index + 1} · ${options.formatWager(hand.wager)}`;

		const value = document.createElement('p');
		value.dataset.testid = `${options.testIdPrefix}-player-value`;
		value.className = HAND_VALUE_CLASS;
		value.textContent = formatBlackjackHandValue(hand.value);

		const cards = document.createElement('div');
		cards.className = HAND_CARDS_CLASS;
		cards.replaceChildren(
			...hand.cards.map((card) =>
				createBlackjackCardElement(document, card, `${options.testIdPrefix}-player-card`),
			),
		);

		section.replaceChildren(label, value, cards);
		return section;
	});
	playerHandsContainer.replaceChildren(...rendered);
}
