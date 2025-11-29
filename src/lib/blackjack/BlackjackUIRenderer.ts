/**
 * BlackjackUIRenderer - UI update logic for Blackjack game
 * Handles DOM manipulation and visual updates
 */

import type { Hand, BlackjackGameState, BlackjackAction } from './types';
import { getHandValueDisplay } from './handEvaluator';

export class BlackjackUIRenderer {
	/**
	 * Render player hand(s) to the DOM
	 */
	public renderPlayerHand(hand: Hand, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const handValue = getHandValueDisplay(hand.cards);
		const cardsHTML = hand.cards
			.map(
				(card) => `
			<div class="card" data-rank="${card.rank}" data-suit="${card.suit}">
				${card.rank}${this.getSuitSymbol(card.suit)}
			</div>
		`,
			)
			.join('');

		container.innerHTML = `
			<div class="hand-cards">${cardsHTML}</div>
			<div class="hand-value">${handValue}</div>
			<div class="hand-bet">Bet: $${hand.bet}</div>
		`;
	}

	/**
	 * Render dealer hand to the DOM (with optional hidden card)
	 */
	public renderDealerHand(hand: Hand, containerSelector: string, hideSecondCard = false): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const visibleCards = hideSecondCard ? hand.cards.slice(0, 1) : hand.cards;
		const handValue = hideSecondCard ? '?' : getHandValueDisplay(hand.cards);

		const cardsHTML = visibleCards
			.map(
				(card) => `
			<div class="card" data-rank="${card.rank}" data-suit="${card.suit}">
				${card.rank}${this.getSuitSymbol(card.suit)}
			</div>
		`,
			)
			.join('');

		const hiddenCardHTML = hideSecondCard ? '<div class="card card-hidden">🂠</div>' : '';

		container.innerHTML = `
			<div class="hand-cards">${cardsHTML}${hiddenCardHTML}</div>
			<div class="hand-value">Dealer: ${handValue}</div>
		`;
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
				const handsHTML = state.playerHands
					.map((hand, index) => {
						const isActive = index === state.activeHandIndex;
						const handValue = getHandValueDisplay(hand.cards);
						const cardsHTML = hand.cards
							.map(
								(card) => `
									<div class="card" data-rank="${card.rank}" data-suit="${card.suit}">
										${card.rank}${this.getSuitSymbol(card.suit)}
									</div>
								`,
							)
							.join('');
						const activeClass = isActive ? 'hand-active' : 'hand-inactive';
						return `
							<div class="player-hand ${activeClass}" data-hand-index="${index}">
								<div class="hand-label">Hand ${index + 1}${isActive ? ' (Active)' : ''}</div>
								<div class="hand-cards">${cardsHTML}</div>
								<div class="hand-value">${handValue}</div>
								<div class="hand-bet">Bet: $${hand.bet}</div>
							</div>
						`;
					})
					.join('');
				playerContainer.innerHTML = `<div class="split-hands">${handsHTML}</div>`;
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
