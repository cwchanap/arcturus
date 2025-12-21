/**
 * BlackjackUIRenderer - UI update logic for Blackjack game
 * Handles DOM manipulation and visual updates
 */

import type { Hand, BlackjackGameState, BlackjackAction } from './types';
import { getHandValueDisplay } from './handEvaluator';
import { clearChildren } from '../dom-utils';

export class BlackjackUIRenderer {
	/**
	 * Render player hand(s) to the DOM
	 */
	public renderPlayerHand(hand: Hand, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const handValue = getHandValueDisplay(hand.cards);

		// Build DOM structure
		const cardsDiv = document.createElement('div');
		cardsDiv.className = 'hand-cards';
		hand.cards.forEach((card) => {
			const cardEl = this.createBlackjackCard(card.rank, card.suit);
			cardEl.dataset.rank = card.rank;
			cardEl.dataset.suit = card.suit;
			cardsDiv.appendChild(cardEl);
		});

		const valueDiv = document.createElement('div');
		valueDiv.className = 'hand-value';
		valueDiv.textContent = handValue;

		const betDiv = document.createElement('div');
		betDiv.className = 'hand-bet';
		betDiv.textContent = `Bet: $${hand.bet}`;

		clearChildren(container);
		container.appendChild(cardsDiv);
		container.appendChild(valueDiv);
		container.appendChild(betDiv);
	}

	/**
	 * Render dealer hand to the DOM (with optional hidden card)
	 */
	public renderDealerHand(hand: Hand, containerSelector: string, hideSecondCard = false): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const visibleCards = hideSecondCard ? hand.cards.slice(0, 1) : hand.cards;
		const handValue = hideSecondCard ? '?' : getHandValueDisplay(hand.cards);

		// Build DOM structure
		const cardsDiv = document.createElement('div');
		cardsDiv.className = 'hand-cards';

		visibleCards.forEach((card) => {
			const cardEl = this.createBlackjackCard(card.rank, card.suit);
			cardEl.dataset.rank = card.rank;
			cardEl.dataset.suit = card.suit;
			cardsDiv.appendChild(cardEl);
		});

		if (hideSecondCard) {
			const hiddenCard = document.createElement('div');
			hiddenCard.className = 'card card-hidden';
			hiddenCard.textContent = '🂠';
			cardsDiv.appendChild(hiddenCard);
		}

		const valueDiv = document.createElement('div');
		valueDiv.className = 'hand-value';
		valueDiv.textContent = `Dealer: ${handValue}`;

		clearChildren(container);
		container.appendChild(cardsDiv);
		container.appendChild(valueDiv);
	}

	/**
	 * Update game status message
	 */
	public updateGameStatus(message: string, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = message;
		}
	}

	/**
	 * Update balance display
	 */
	public updateBalance(balance: number, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = `$${balance}`;
		}
	}

	/**
	 * Update pot display
	 */
	public updatePot(pot: number, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = `Pot: $${pot}`;
		}
	}

	/**
	 * Enable/disable action buttons based on available actions
	 */
	public updateActionButtons(
		availableActions: BlackjackAction[],
		buttonSelectors: Record<string, string>,
	): void {
		// Disable all buttons first
		Object.values(buttonSelectors).forEach((selector) => {
			const button = document.querySelector(selector) as HTMLButtonElement;
			if (button) button.disabled = true;
		});

		// Enable available actions
		availableActions.forEach((action) => {
			const selector = buttonSelectors[action];
			if (selector) {
				const button = document.querySelector(selector) as HTMLButtonElement;
				if (button) button.disabled = false;
			}
		});
	}

	/**
	 * Show/hide betting UI
	 */
	public toggleBettingUI(show: boolean, containerSelector: string): void {
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
	 * Show/hide game controls
	 */
	public toggleGameControls(show: boolean, containerSelector: string): void {
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
	 * Get suit symbol for display
	 */
	private getSuitSymbol(suit: string): string {
		const symbols: Record<string, string> = {
			hearts: '♥',
			diamonds: '♦',
			clubs: '♣',
			spades: '♠',
		};
		return symbols[suit] || suit;
	}

	/**
	 * Create a blackjack card element
	 */
	private createBlackjackCard(rank: string, suit: string): HTMLDivElement {
		const card = document.createElement('div');
		card.className = 'card';
		card.textContent = `${rank}${this.getSuitSymbol(suit)}`;
		return card;
	}

	/**
	 * Render complete game state (useful for full updates)
	 */
	public renderGameState(
		state: BlackjackGameState,
		selectors: {
			playerHandContainer: string;
			dealerHandContainer: string;
			statusContainer: string;
			balanceContainer: string;
			potContainer: string;
		},
	): void {
		// Render player hand(s) - supports split hands
		const playerContainer = document.querySelector(selectors.playerHandContainer);
		if (playerContainer && state.playerHands.length > 0) {
			if (state.playerHands.length === 1) {
				// Single hand - use existing method
				this.renderPlayerHand(state.playerHands[0], selectors.playerHandContainer);
			} else {
				// Multiple hands (split) - render all with active indicator
				const splitHandsDiv = document.createElement('div');
				splitHandsDiv.className = 'split-hands';

				state.playerHands.forEach((hand, index) => {
					const isActive = index === state.activeHandIndex;
					const handValue = getHandValueDisplay(hand.cards);
					const activeClass = isActive ? 'hand-active' : 'hand-inactive';

					const handDiv = document.createElement('div');
					handDiv.className = `player-hand ${activeClass}`;
					handDiv.dataset.handIndex = String(index);

					const labelDiv = document.createElement('div');
					labelDiv.className = 'hand-label';
					labelDiv.textContent = `Hand ${index + 1}${isActive ? ' (Active)' : ''}`;

					const cardsDiv = document.createElement('div');
					cardsDiv.className = 'hand-cards';
					hand.cards.forEach((card) => {
						const cardEl = this.createBlackjackCard(card.rank, card.suit);
						cardEl.dataset.rank = card.rank;
						cardEl.dataset.suit = card.suit;
						cardsDiv.appendChild(cardEl);
					});

					const valueDiv = document.createElement('div');
					valueDiv.className = 'hand-value';
					valueDiv.textContent = handValue;

					const betDiv = document.createElement('div');
					betDiv.className = 'hand-bet';
					betDiv.textContent = `Bet: $${hand.bet}`;

					handDiv.appendChild(labelDiv);
					handDiv.appendChild(cardsDiv);
					handDiv.appendChild(valueDiv);
					handDiv.appendChild(betDiv);
					splitHandsDiv.appendChild(handDiv);
				});

				clearChildren(playerContainer);
				playerContainer.appendChild(splitHandsDiv);
			}
		}

		// Render dealer hand (hide second card if player is still playing)
		const hideCard = state.phase === 'player-turn' || state.phase === 'dealing';
		this.renderDealerHand(state.dealerHand, selectors.dealerHandContainer, hideCard);

		// Update balance and pot
		this.updateBalance(state.playerBalance, selectors.balanceContainer);
		this.updatePot(state.pot, selectors.potContainer);

		// Update status message based on phase
		let statusMessage = '';
		switch (state.phase) {
			case 'betting':
				statusMessage = 'Place your bet';
				break;
			case 'dealing':
				statusMessage = 'Dealing cards...';
				break;
			case 'player-turn':
				statusMessage = 'Your turn - Hit or Stand?';
				break;
			case 'dealer-turn':
				statusMessage = 'Dealer playing...';
				break;
			case 'complete':
				statusMessage = 'Round complete';
				break;
		}
		this.updateGameStatus(statusMessage, selectors.statusContainer);
	}
}
