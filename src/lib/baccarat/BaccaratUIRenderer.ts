/**
 * BaccaratUIRenderer - UI update logic for Baccarat game
 * Handles DOM manipulation and visual updates
 */

import type { Card, Hand, RoundOutcome, Bet, BetType } from './types';
import { getHandValue } from './handEvaluator';
import { ANIMATION_SPEED_SLOW, ANIMATION_SPEED_NORMAL, ANIMATION_SPEED_FAST } from './constants';
import type { AnimationSpeed } from './types';
import {
	clearChildren,
	createTextSpan,
	createBetChip,
	createBetResult,
	createScoreboardDot,
} from '../dom-utils';
import { setSlotState } from '../card-slot-utils';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { formatWholeNumber } from '../formatting';
import { formatChips } from '../i18n/messages/common';
import {
	baccaratTranslator,
	getBaccaratBetTypeLabel,
	getBaccaratWinnerLabel,
	getBaccaratOutcomeLabel,
	formatBaccaratNet,
	type BACCARAT_MESSAGES,
} from '../i18n/messages/baccarat';
import type { MessageKey } from '../i18n/translate';

type Translator = ReturnType<typeof baccaratTranslator>;

const PAIR_KEYS: Record<'playerPair' | 'bankerPair', MessageKey<typeof BACCARAT_MESSAGES>> = {
	playerPair: 'playerPair',
	bankerPair: 'bankerPair',
};

export class BaccaratUIRenderer {
	private animationSpeed: number = ANIMATION_SPEED_NORMAL;
	private readonly locale: Locale;
	private readonly t: Translator;

	constructor() {
		// AppLayout writes data-locale on <html>; the renderer reads it so the
		// browser and SSR share one locale handoff.
		this.locale = getDocumentLocale();
		this.t = baccaratTranslator(this.locale);
	}

	/**
	 * Set animation speed
	 */
	public setAnimationSpeed(speed: AnimationSpeed): void {
		switch (speed) {
			case 'slow':
				this.animationSpeed = ANIMATION_SPEED_SLOW;
				break;
			case 'fast':
				this.animationSpeed = ANIMATION_SPEED_FAST;
				break;
			default:
				this.animationSpeed = ANIMATION_SPEED_NORMAL;
		}
	}

	/**
	 * Get animation delay
	 */
	public getAnimationDelay(): number {
		return this.animationSpeed;
	}

	/**
	 * Render a hand to the DOM using pre-rendered card slots
	 */
	public renderHand(hand: Hand, containerSelector: string, _label: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const handValue = hand.cards.length > 0 ? getHandValue(hand) : '';

		// Find the card container and update slots
		const cardsContainer = container.querySelector('[data-baccarat-card-container]');
		if (cardsContainer) {
			const slots = cardsContainer.querySelectorAll('.card-slot');
			slots.forEach((slot, index) => {
				if (index < hand.cards.length) {
					const card = hand.cards[index];
					setSlotState(slot, 'card', { rank: card.rank, suit: card.suit });
				} else if (index < 2) {
					// Show placeholders for first 2 slots
					setSlotState(slot, 'placeholder');
				} else {
					setSlotState(slot, 'hidden');
				}
			});
		}

		// Update hand value element
		const valueEl = container.querySelector('.hand-value');
		if (valueEl) {
			valueEl.textContent = handValue !== '' ? String(handValue) : '';
		}
	}

	/**
	 * Render player hand
	 */
	public renderPlayerHand(hand: Hand, containerSelector: string): void {
		this.renderHand(hand, containerSelector, 'PLAYER');
	}

	/**
	 * Render banker hand
	 */
	public renderBankerHand(hand: Hand, containerSelector: string): void {
		this.renderHand(hand, containerSelector, 'BANKER');
	}

	/**
	 * Add a card to hand with animation using pre-rendered slots
	 */
	public async addCardToHand(
		card: Card,
		containerSelector: string,
		position: number,
		handCards: Card[],
	): Promise<void> {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		// Find the card container and update the specific slot
		const cardsContainer = container.querySelector('[data-baccarat-card-container]');
		if (!cardsContainer) return;

		const slots = cardsContainer.querySelectorAll('.card-slot');
		const slot = slots[position];
		if (slot) {
			setSlotState(slot, 'card', { rank: card.rank, suit: card.suit });
		}

		// Wait for animation
		await this.delay(this.animationSpeed);

		// Update hand value using authoritative state
		const handValueElement = container.querySelector('.hand-value');
		if (handValueElement && handCards.length > 0) {
			const value = getHandValue({ cards: handCards });
			handValueElement.textContent = String(value);
		}
	}

	/**
	 * Render active bets display
	 */
	public renderBets(bets: Bet[], containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		clearChildren(container);

		if (bets.length === 0) {
			container.appendChild(createTextSpan(this.t('noBetsPlaced'), 'text-[var(--deco-muted)]'));
			return;
		}

		bets.forEach((bet) => {
			const chip = createBetChip(
				getBaccaratBetTypeLabel(this.locale, bet.type),
				formatChips(bet.amount, this.locale),
			);
			chip.dataset.type = bet.type;
			container.appendChild(chip);
		});
	}

	/**
	 * Update bet area highlight
	 */
	public updateBetAreaHighlight(type: BetType, isActive: boolean, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		if (isActive) {
			container.classList.add('bet-area-active');
		} else {
			container.classList.remove('bet-area-active');
		}
	}

	/**
	 * Render round result
	 */
	public renderRoundResult(outcome: RoundOutcome, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const winnerText = getBaccaratWinnerLabel(this.locale, outcome.winner);
		const naturalText = outcome.isNatural ? this.t('naturalSuffix') : '';
		const pairText = this.formatPairs(outcome.playerPair, outcome.bankerPair);

		// Build DOM structure
		const winnerDiv = document.createElement('div');
		winnerDiv.className = 'result-winner';
		winnerDiv.textContent = winnerText + naturalText;

		const scoresDiv = document.createElement('div');
		scoresDiv.className = 'result-scores';
		scoresDiv.textContent = this.t('scoresLine', {
			player: String(outcome.playerValue),
			banker: String(outcome.bankerValue),
		});

		const betsDiv = document.createElement('div');
		betsDiv.className = 'result-bets';
		outcome.betResults.forEach((result) => {
			betsDiv.appendChild(
				createBetResult(
					getBaccaratBetTypeLabel(this.locale, result.bet.type),
					result.outcome,
					getBaccaratOutcomeLabel(this.locale, result.outcome),
					formatBaccaratNet(this.locale, result.payout),
				),
			);
		});

		clearChildren(container);
		container.appendChild(winnerDiv);
		container.appendChild(scoresDiv);

		if (pairText) {
			const pairsDiv = document.createElement('div');
			pairsDiv.className = 'result-pairs';
			pairsDiv.textContent = pairText;
			container.appendChild(pairsDiv);
		}

		container.appendChild(betsDiv);
		container.classList.remove('hidden');
	}

	/**
	 * Hide result display
	 */
	public hideRoundResult(containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.classList.add('hidden');
		}
	}

	/**
	 * Update balance display
	 */
	public updateBalance(balance: number, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = formatChips(balance, this.locale);
		}
	}

	/**
	 * Update shoe cards remaining
	 */
	public updateShoeCount(remaining: number, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = this.t('shoeCount', {
				count: formatWholeNumber(remaining, this.locale),
			});
		}
	}

	/**
	 * Render scoreboard (last N rounds)
	 */
	public renderScoreboard(history: RoundOutcome[], containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		clearChildren(container);

		if (history.length === 0) {
			container.appendChild(createTextSpan(this.t('noHistoryYet'), 'text-[var(--deco-muted)]'));
			return;
		}

		history.forEach((round) => {
			const dot = createScoreboardDot(round.winner);
			dot.title = getBaccaratWinnerLabel(this.locale, round.winner);
			container.appendChild(dot);
		});
	}

	/**
	 * Show game status message
	 */
	public showStatus(message: string, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = message;
			container.classList.remove('hidden');
		}
	}

	/**
	 * Hide game status
	 */
	public hideStatus(containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.classList.add('hidden');
		}
	}

	/**
	 * Show/hide insufficient chips overlay
	 */
	public toggleInsufficientChipsOverlay(show: boolean, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			if (show) {
				container.classList.remove('hidden');
			} else {
				container.classList.add('hidden');
			}
		}
	}

	/**
	 * Enable/disable deal button
	 */
	public setDealButtonEnabled(enabled: boolean, buttonSelector: string): void {
		const button = document.querySelector(buttonSelector) as HTMLButtonElement;
		if (button) {
			button.disabled = !enabled;
		}
	}

	/**
	 * Toggle betting area enabled state
	 */
	public setBettingEnabled(enabled: boolean, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			if (enabled) {
				container.classList.remove('betting-disabled');
			} else {
				container.classList.add('betting-disabled');
			}
		}
	}

	// ===== Private Helpers =====

	private formatPairs(playerPair: boolean, bankerPair: boolean): string {
		const pairs = [];
		if (playerPair) pairs.push(this.t(PAIR_KEYS.playerPair));
		if (bankerPair) pairs.push(this.t(PAIR_KEYS.bankerPair));
		return pairs.join(' | ');
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
