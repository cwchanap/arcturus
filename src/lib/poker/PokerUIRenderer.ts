/**
 * PokerUIRenderer - Handles all DOM manipulation and UI updates
 */

import type { Card, GamePhase, Player } from './types';
import type { PokerHandNameKey } from './constants';
import { renderCardsToContainer, setSlotState } from '../card-slot-utils';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import {
	getPokerCardName,
	getPokerHandName,
	pokerTranslator,
	type POKER_MESSAGES,
} from '../i18n/messages/poker';
import type { MessageKey } from '../i18n/translate';

type Translator = ReturnType<typeof pokerTranslator>;

const PHASE_KEYS: Record<GamePhase, MessageKey<typeof POKER_MESSAGES>> = {
	idle: 'phaseIdle',
	dealing: 'phaseDealing',
	preflop: 'phasePreflop',
	flop: 'phaseFlop',
	turn: 'phaseTurn',
	river: 'phaseRiver',
	showdown: 'phaseShowdown',
	complete: 'phaseComplete',
};

/**
 * Presentational hand-strength classification for the human's combined cards.
 * Returns a closed `PokerHandNameKey` (or null below two cards); display
 * labels are translated through `messages/poker.ts`, never raw English names.
 */
export function evaluateHandKey(
	humanPlayer: Player,
	communityCards: Card[],
): PokerHandNameKey | null {
	const allCards = [...humanPlayer.hand, ...communityCards];
	if (allCards.length < 2) return null;

	const values = allCards.map((c) => c.value);
	const suits = allCards.map((c) => c.suit);

	const valueCounts: Record<string, number> = {};
	values.forEach((v) => (valueCounts[v] = (valueCounts[v] || 0) + 1));

	const counts = Object.values(valueCounts).sort((a, b) => b - a);
	const isFlush = suits.every((s) => s === suits[0]) && suits.length >= 5;

	// Straight detection across the combined ranks, including the A-2-3-4-5
	// wheel where the ace plays low. Simplified presentation heuristic, not an
	// authoritative ranking — showdowns use `determineShowdownWinners`.
	const sortedRanks = [...new Set(allCards.map((c) => c.rank))].sort((a, b) => b - a);
	let straightHigh = 0;
	if (sortedRanks.length >= 5) {
		for (let i = 0; i <= sortedRanks.length - 5; i++) {
			if (sortedRanks[i] - sortedRanks[i + 4] === 4) {
				straightHigh = sortedRanks[i];
				break;
			}
		}
		if (
			straightHigh === 0 &&
			sortedRanks.includes(14) &&
			sortedRanks.includes(5) &&
			sortedRanks.includes(4) &&
			sortedRanks.includes(3) &&
			sortedRanks.includes(2)
		) {
			straightHigh = 5;
		}
	}

	if (isFlush && straightHigh > 0) {
		return straightHigh === 14 ? 'ROYAL_FLUSH' : 'STRAIGHT_FLUSH';
	}
	if (counts[0] === 4) return 'FOUR_OF_A_KIND';
	if (counts[0] === 3 && counts[1] === 2) return 'FULL_HOUSE';
	if (isFlush) return 'FLUSH';
	if (straightHigh > 0) return 'STRAIGHT';
	if (counts[0] === 3) return 'THREE_OF_A_KIND';
	if (counts[0] === 2 && counts[1] === 2) return 'TWO_PAIR';
	if (counts[0] === 2) return 'PAIR';
	return 'HIGH_CARD';
}

export class PokerUIRenderer {
	private readonly locale: Locale;
	private readonly t: Translator;

	constructor() {
		// AppLayout writes data-locale on <html>; the renderer reads it so the
		// browser and SSR share one locale handoff.
		this.locale = getDocumentLocale();
		this.t = pokerTranslator(this.locale);
	}

	public renderPlayerCards(humanPlayer: Player, communityCards: Card[]) {
		// Convert Card type to CardData format expected by card-slot-utils
		const cards = humanPlayer.hand.map((card) => ({ rank: card.value, suit: card.suit }));
		renderCardsToContainer('player-cards', cards, { showPlaceholders: 0 });

		const container = document.getElementById('player-cards');
		const slots = container?.querySelectorAll('.card-slot');
		slots?.forEach((slot, index) => {
			const card = humanPlayer.hand[index];
			if (card) {
				this.setCardA11y(slot, card);
			} else {
				this.clearCardA11y(slot);
			}
		});

		this.evaluateHand(humanPlayer, communityCards);
	}

	public renderCommunityCards(communityCards: Card[]) {
		const container = document.getElementById('community-cards');
		if (!container) return;

		// Convert Card type to CardData format
		const cards = communityCards.map((card) => ({ rank: card.value, suit: card.suit }));

		// Update slots - show cards for dealt cards, placeholders for undealt
		const slots = container.querySelectorAll('.card-slot');
		slots.forEach((slot, index) => {
			if (index < cards.length) {
				setSlotState(slot, 'card', cards[index]);
				this.setCardA11y(slot, communityCards[index]);
			} else {
				setSlotState(slot, 'placeholder');
				this.clearCardA11y(slot);
			}
		});
	}

	public updateOpponentUI(players: Player[]) {
		// Update opponent chip counts using direct ID selectors
		if (players[1]) {
			const opponent1Chips = document.getElementById('opponent1-chips');
			if (opponent1Chips) {
				opponent1Chips.textContent = formatChips(players[1].chips, this.locale);
			}
			// Update folded state
			this.updateFoldedState(1, players[1].folded);
		}
		if (players[2]) {
			const opponent2Chips = document.getElementById('opponent2-chips');
			if (opponent2Chips) {
				opponent2Chips.textContent = formatChips(players[2].chips, this.locale);
			}
			// Update folded state
			this.updateFoldedState(2, players[2].folded);
		}
	}

	/**
	 * Update folded state indicator for opponent
	 */
	private updateFoldedState(playerIndex: number, folded: boolean) {
		const container = document.getElementById(`opponent${playerIndex === 1 ? '1' : '2'}-cards`);
		if (!container) return;

		const parent = container.parentElement;
		if (!parent) return;

		if (folded) {
			parent.classList.add('opacity-40');
			parent.classList.add('grayscale');
			// Add folded badge if not exists
			if (!parent.querySelector('.folded-badge')) {
				const badge = document.createElement('div');
				badge.className =
					'folded-badge absolute top-0 right-0 bg-[var(--deco-oxblood-bright)] text-white text-xs px-2 py-1 rounded';
				badge.textContent = this.t('foldedBadge');
				parent.style.position = 'relative';
				parent.appendChild(badge);
			}
		} else {
			parent.classList.remove('opacity-40');
			parent.classList.remove('grayscale');
			// Remove folded badge if exists
			const badge = parent.querySelector('.folded-badge');
			if (badge) {
				badge.remove();
			}
		}
	}

	/**
	 * Show AI decision next to opponent badge
	 */
	public showAIDecision(playerIndex: number, action: string, amount?: number) {
		const container = document.getElementById(`opponent${playerIndex === 1 ? '1' : '2'}-cards`);
		if (!container) return;

		const parent = container.parentElement;
		if (!parent) return;

		// Remove existing decision badge
		const existingBadge = parent.querySelector('.ai-decision-badge');
		if (existingBadge) {
			existingBadge.remove();
		}

		// Create decision badge
		const badge = document.createElement('div');
		badge.className =
			'ai-decision-badge absolute -bottom-2 left-1/2 transform -translate-x-1/2 text-xs px-2 py-1 rounded font-semibold shadow-lg whitespace-nowrap z-10';
		parent.style.position = 'relative';

		// Style based on action
		switch (action.toLowerCase()) {
			case 'fold':
				badge.className += ' bg-[var(--deco-oxblood-bright)] text-white';
				badge.textContent = this.t('badgeFold');
				break;
			case 'check':
				badge.className += ' bg-[var(--deco-sapphire)] text-white';
				badge.textContent = this.t('badgeCheck');
				break;
			case 'call':
				badge.className += ' bg-[var(--deco-jade)] text-[var(--deco-obsidian)]';
				badge.textContent = this.t('badgeCall', {
					amount: formatChips(amount || 0, this.locale),
				});
				break;
			case 'raise':
				badge.className += ' bg-[var(--deco-brass)] text-[var(--deco-obsidian)]';
				badge.textContent = this.t('badgeRaise', {
					amount: formatChips(amount || 0, this.locale),
				});
				break;
			default:
				badge.className += ' bg-[var(--deco-obsidian-3)] text-white';
				badge.textContent = action.toUpperCase();
		}

		parent.appendChild(badge);

		// Auto-remove after 3 seconds
		setTimeout(() => {
			if (badge.parentElement) {
				badge.remove();
			}
		}, 3000);
	}

	public revealOpponentHands(players: Player[], winners: Player[]) {
		// Reveal Player 2's hand
		if (players[1] && !players[1].folded) {
			const opponent1Container = document.getElementById('opponent1-cards');
			if (opponent1Container) {
				const isWinner = winners.some((w) => w.id === players[1].id);
				const cards = players[1].hand.map((card) => ({ rank: card.value, suit: card.suit }));
				const slots = opponent1Container.querySelectorAll('.card-slot');
				slots.forEach((slot, index) => {
					if (index < cards.length) {
						setSlotState(slot, 'card', cards[index]);
						this.setCardA11y(slot, players[1].hand[index]);
						// Add winner highlight if needed
						if (isWinner) {
							slot.classList.add('ring-2', 'ring-[var(--deco-brass-bright)]');
						}
					} else {
						setSlotState(slot, 'hidden');
						this.clearCardA11y(slot);
					}
				});
			}
		}

		// Reveal Player 3's hand
		if (players[2] && !players[2].folded) {
			const opponent2Container = document.getElementById('opponent2-cards');
			if (opponent2Container) {
				const isWinner = winners.some((w) => w.id === players[2].id);
				const cards = players[2].hand.map((card) => ({ rank: card.value, suit: card.suit }));
				const slots = opponent2Container.querySelectorAll('.card-slot');
				slots.forEach((slot, index) => {
					if (index < cards.length) {
						setSlotState(slot, 'card', cards[index]);
						this.setCardA11y(slot, players[2].hand[index]);
						// Add winner highlight if needed
						if (isWinner) {
							slot.classList.add('ring-2', 'ring-[var(--deco-brass-bright)]');
						}
					} else {
						setSlotState(slot, 'hidden');
						this.clearCardA11y(slot);
					}
				});
			}
		}
	}

	public hideOpponentHands() {
		// Reset to face-down cards for opponents
		const opponent1Container = document.getElementById('opponent1-cards');
		const opponent2Container = document.getElementById('opponent2-cards');

		[opponent1Container, opponent2Container].forEach((container) => {
			if (!container) return;
			const slots = container.querySelectorAll('.card-slot');
			slots.forEach((slot, index) => {
				// Remove any winner highlight
				slot.classList.remove('ring-2', 'ring-[var(--deco-brass-bright)]');
				if (index < 2) {
					setSlotState(slot, 'facedown');
					this.setCardA11y(slot, null);
				} else {
					setSlotState(slot, 'hidden');
					this.clearCardA11y(slot);
				}
			});
		});
	}

	/** Localized accessible name for a shown card; null for a face-down card. */
	private setCardA11y(slot: Element, card: Card | null): void {
		if (card) {
			slot.setAttribute('role', 'img');
			slot.setAttribute('aria-label', getPokerCardName(this.locale, card));
		} else {
			slot.setAttribute('role', 'img');
			slot.setAttribute('aria-label', this.t('cardFaceDown'));
		}
	}

	private clearCardA11y(slot: Element): void {
		slot.removeAttribute('role');
		slot.removeAttribute('aria-label');
	}

	private evaluateHand(humanPlayer: Player, communityCards: Card[]) {
		const strengthEl = document.getElementById('hand-strength');
		if (!strengthEl) return;

		const key = evaluateHandKey(humanPlayer, communityCards);
		strengthEl.textContent = key ? getPokerHandName(this.locale, key) : '--';
	}

	public updateUI(pot: number, humanPlayer: Player) {
		const potEl = document.getElementById('pot-amount');
		const betEl = document.getElementById('current-bet');
		const balanceEl = document.getElementById('player-balance');

		if (potEl) potEl.textContent = formatChips(pot, this.locale);
		if (betEl) betEl.textContent = formatChips(humanPlayer.currentBet, this.locale);
		if (balanceEl) balanceEl.textContent = formatChips(humanPlayer.chips, this.locale);
	}

	public updateGameStatus(message: string, gamePhase: GamePhase, pot: number) {
		const statusEl = document.getElementById('game-status');
		if (!statusEl) return;

		const phaseLabel = this.t(PHASE_KEYS[gamePhase]);
		if (pot > 0) {
			statusEl.textContent = this.t('statusWithPot', {
				phase: phaseLabel,
				pot: this.t('potLabel', { amount: formatChips(pot, this.locale) }),
				message,
			});
		} else {
			statusEl.textContent = this.t('statusPlain', { phase: phaseLabel, message });
		}
	}
}
