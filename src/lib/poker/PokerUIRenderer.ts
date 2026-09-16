/**
 * PokerUIRenderer - Handles all DOM manipulation and UI updates
 */

import type { Card, GamePhase, Player } from './types';
import { HAND_RANKINGS, NUM_PLAYERS, type PokerHandNameKey } from './constants';
import { formatWholeNumber } from '../formatting';
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

	const valueCounts: Record<number, number> = {};
	const suitCounts: Record<string, number> = {};
	for (const card of allCards) {
		valueCounts[card.rank] = (valueCounts[card.rank] || 0) + 1;
		suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
	}

	const counts = Object.values(valueCounts).sort((a, b) => b - a);
	const maxSuitCount = Math.max(...Object.values(suitCounts));
	const hasFlush = maxSuitCount >= 5;

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

	// A straight flush requires the straight to be in the flush suit.
	// hasFlush && straightHigh can both be true when the flush and straight
	// use different cards, so verify the flush-suit ranks contain a straight.
	let straightFlushHigh = 0;
	if (hasFlush && straightHigh > 0) {
		const flushSuit = Object.entries(suitCounts).find(([, count]) => count >= 5)?.[0];
		if (flushSuit) {
			const flushRanks = allCards.filter((c) => c.suit === flushSuit).map((c) => c.rank);
			const sortedFlushRanks = [...new Set(flushRanks)].sort((a, b) => b - a);
			for (let i = 0; i <= sortedFlushRanks.length - 5; i++) {
				if (sortedFlushRanks[i] - sortedFlushRanks[i + 4] === 4) {
					straightFlushHigh = sortedFlushRanks[i];
					break;
				}
			}
			if (
				straightFlushHigh === 0 &&
				sortedFlushRanks.includes(14) &&
				sortedFlushRanks.includes(5) &&
				sortedFlushRanks.includes(4) &&
				sortedFlushRanks.includes(3) &&
				sortedFlushRanks.includes(2)
			) {
				straightFlushHigh = 5;
			}
		}
	}

	if (straightFlushHigh > 0) {
		return straightFlushHigh === 14 ? 'ROYAL_FLUSH' : 'STRAIGHT_FLUSH';
	}
	if (counts[0] === 4) return 'FOUR_OF_A_KIND';
	if (counts[0] === 3 && counts[1] >= 2) return 'FULL_HOUSE';
	if (hasFlush) return 'FLUSH';
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
		for (const player of players.slice(1)) {
			const chips = document.getElementById(`opponent${player.id}-chips`);
			if (chips) chips.textContent = formatWholeNumber(player.chips, this.locale);
			this.updateFoldedState(player.id, player.folded);
		}
	}

	/**
	 * Update folded state indicator for opponent
	 */
	private updateFoldedState(playerIndex: number, folded: boolean) {
		const container = document.getElementById(`opponent${playerIndex}-cards`);
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
		const container = document.getElementById(`opponent${playerIndex}-cards`);
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
		for (const player of players.slice(1)) {
			if (player.folded) continue;
			const container = document.getElementById(`opponent${player.id}-cards`);
			const isWinner = winners.some((winner) => winner.id === player.id);
			container?.querySelectorAll('.card-slot').forEach((slot, index) => {
				const card = player.hand[index];
				if (card) {
					setSlotState(slot, 'card', { rank: card.value, suit: card.suit });
					this.setCardA11y(slot, card);
					if (isWinner) slot.classList.add('ring-2', 'ring-[var(--deco-brass-bright)]');
				} else {
					setSlotState(slot, 'hidden');
					this.clearCardA11y(slot);
				}
			});
		}
	}

	public hideOpponentHands() {
		// Reset to face-down cards for opponents
		Array.from({ length: NUM_PLAYERS - 1 }, (_, i) =>
			document.getElementById(`opponent${i + 1}-cards`),
		).forEach((container) => {
			container?.parentElement?.querySelector('.ai-decision-badge')?.remove();
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
		document.querySelectorAll<HTMLElement>('.poker-strength-bars span').forEach((bar, index) => {
			bar.dataset.lit = String(key !== null && index < Math.ceil((HAND_RANKINGS[key] + 1) / 2));
		});
	}

	public updateUI(pot: number, humanPlayer: Player) {
		const potEl = document.getElementById('pot-amount');
		const betEl = document.getElementById('current-bet');
		const balanceEl = document.getElementById('player-balance');

		if (potEl) potEl.textContent = formatWholeNumber(pot, this.locale);
		if (betEl) betEl.textContent = formatChips(humanPlayer.currentBet, this.locale);
		if (balanceEl) balanceEl.textContent = formatChips(humanPlayer.chips, this.locale);
	}

	public updateTableState(
		players: Player[],
		dealerIndex: number,
		currentPlayerIndex: number,
		active: boolean,
	) {
		for (const player of players) {
			const seat = document.getElementById(`poker-seat-${player.id}`);
			if (!seat) continue;
			const isTurn =
				active && player.id === currentPlayerIndex && !player.folded && !player.isAllIn;
			seat.dataset.turn = String(isTurn);
			seat.dataset.folded = String(player.folded);
			const position = document.getElementById(`position-${player.id}`);
			if (position)
				position.textContent = ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'][
					(player.id - dealerIndex + players.length) % players.length
				];
			const action = document.getElementById(`opponent${player.id}-action`);
			if (action)
				action.textContent = player.folded
					? this.t('foldedBadge')
					: player.isAllIn
						? this.t('allIn')
						: isTurn
							? this.t('thinking')
							: player.currentBet > 0
								? formatWholeNumber(player.currentBet, this.locale)
								: '—';
		}
		this.updateOpponentUI(players);
	}

	public updateGameStatus(message: string, gamePhase: GamePhase, pot: number) {
		const statusEl = document.getElementById('game-status');
		if (!statusEl) return;

		const phaseLabel = this.t(PHASE_KEYS[gamePhase]);
		const phase = document.getElementById('poker-phase');
		if (phase) phase.textContent = phaseLabel;
		const phaseIndex = ['preflop', 'flop', 'turn', 'river', 'showdown'].indexOf(gamePhase);
		document.querySelectorAll<HTMLElement>('[data-street]').forEach((street, index) => {
			street.dataset.reached = String(index <= phaseIndex);
			if (index === phaseIndex) street.setAttribute('aria-current', 'step');
			else street.removeAttribute('aria-current');
		});
		const history = document.getElementById('poker-history');
		if (history && history.firstElementChild?.textContent !== `[${phaseLabel}] ${message}`) {
			const entry = document.createElement('li');
			entry.textContent = `[${phaseLabel}] ${message}`;
			history.insertBefore(entry, history.firstChild);
			// ponytail: retain 100 session events; persist hands only if saved history is needed.
			while (history.children.length > 100) history.lastElementChild?.remove();
			const empty = document.getElementById('poker-history-empty');
			if (empty) empty.hidden = true;
		}
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
