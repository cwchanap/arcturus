/**
 * BaccaratUIRenderer - UI update logic for Baccarat game
 * Handles DOM manipulation and visual updates
 */

import type { Card, Hand, RoundOutcome, Bet, BetType } from './types';
import { getHandValue } from './handEvaluator';
import { ANIMATION_SPEED_SLOW, ANIMATION_SPEED_NORMAL, ANIMATION_SPEED_FAST } from './constants';
import type { AnimationSpeed } from './types';

export class BaccaratUIRenderer {
	private animationSpeed: number = ANIMATION_SPEED_NORMAL;

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
	 * Render a hand to the DOM
	 */
	public renderHand(hand: Hand, containerSelector: string, label: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const handValue = hand.cards.length > 0 ? getHandValue(hand) : '';
		const cardsHTML = hand.cards
			.map(
				(card, index) => `
			<div class="card" data-rank="${card.rank}" data-suit="${card.suit}" style="animation-delay: ${index * 0.2}s">
				<span class="card-rank">${card.rank}</span>
				<span class="card-suit ${this.getSuitColor(card.suit)}">${this.getSuitSymbol(card.suit)}</span>
			</div>
		`,
			)
			.join('');

		container.innerHTML = `
			<div class="hand-label">${label}</div>
			<div class="hand-cards">${cardsHTML || '<div class="card-placeholder"></div>'}</div>
			${handValue !== '' ? `<div class="hand-value">${handValue}</div>` : ''}
		`;
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
	 * Add a card to hand with animation
	 */
	public async addCardToHand(
		card: Card,
		containerSelector: string,
		_position: number,
	): Promise<void> {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		const cardsContainer = container.querySelector('.hand-cards');
		if (!cardsContainer) return;

		// Remove placeholder if present
		const placeholder = cardsContainer.querySelector('.card-placeholder');
		if (placeholder) {
			placeholder.remove();
		}

		const cardElement = document.createElement('div');
		cardElement.className = 'card card-dealing';
		cardElement.dataset.rank = card.rank;
		cardElement.dataset.suit = card.suit;
		cardElement.innerHTML = `
			<span class="card-rank">${card.rank}</span>
			<span class="card-suit ${this.getSuitColor(card.suit)}">${this.getSuitSymbol(card.suit)}</span>
		`;

		cardsContainer.appendChild(cardElement);

		// Wait for animation
		await this.delay(this.animationSpeed);

		// Update hand value
		const allCards = cardsContainer.querySelectorAll('.card');
		const handValueElement = container.querySelector('.hand-value');
		if (handValueElement && allCards.length > 0) {
			// Calculate value from cards in DOM
			const cards: Card[] = Array.from(allCards).map((el) => ({
				rank: (el as HTMLElement).dataset.rank as Card['rank'],
				suit: (el as HTMLElement).dataset.suit as Card['suit'],
			}));
			const value = getHandValue({ cards });
			handValueElement.textContent = String(value);
		}
	}

	/**
	 * Render active bets display
	 */
	public renderBets(bets: Bet[], containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		if (bets.length === 0) {
			container.innerHTML = '<span class="text-neutral-500">No bets placed</span>';
			return;
		}

		const betsHTML = bets
			.map(
				(bet) => `
			<div class="bet-chip" data-type="${bet.type}">
				<span class="bet-type">${this.formatBetType(bet.type)}</span>
				<span class="bet-amount">$${bet.amount}</span>
			</div>
		`,
			)
			.join('');

		container.innerHTML = betsHTML;
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

		const winnerText = this.formatWinner(outcome.winner);
		const naturalText = outcome.isNatural ? ' (Natural!)' : '';
		const pairText = this.formatPairs(outcome.playerPair, outcome.bankerPair);

		const resultsHTML = outcome.betResults
			.map((result) => {
				const outcomeClass =
					result.outcome === 'win'
						? 'text-green-400'
						: result.outcome === 'lose'
							? 'text-red-400'
							: 'text-yellow-400';
				const payoutPrefix = result.payout >= 0 ? '+' : '';
				return `
				<div class="bet-result">
					<span>${this.formatBetType(result.bet.type)}</span>
					<span class="${outcomeClass}">${result.outcome.toUpperCase()}</span>
					<span class="${outcomeClass}">${payoutPrefix}$${result.payout}</span>
				</div>
			`;
			})
			.join('');

		container.innerHTML = `
			<div class="result-winner">${winnerText}${naturalText}</div>
			<div class="result-scores">Player: ${outcome.playerValue} | Banker: ${outcome.bankerValue}</div>
			${pairText ? `<div class="result-pairs">${pairText}</div>` : ''}
			<div class="result-bets">${resultsHTML}</div>
		`;

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
			container.textContent = `$${balance.toLocaleString()}`;
		}
	}

	/**
	 * Update shoe cards remaining
	 */
	public updateShoeCount(remaining: number, containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (container) {
			container.textContent = `${remaining} cards`;
		}
	}

	/**
	 * Render scoreboard (last N rounds)
	 */
	public renderScoreboard(history: RoundOutcome[], containerSelector: string): void {
		const container = document.querySelector(containerSelector);
		if (!container) return;

		if (history.length === 0) {
			container.innerHTML = '<span class="text-neutral-500">No history yet</span>';
			return;
		}

		const dotsHTML = history
			.map((round) => {
				const colorClass = {
					player: 'bg-blue-500',
					banker: 'bg-red-500',
					tie: 'bg-green-500',
				}[round.winner];

				const label = {
					player: 'P',
					banker: 'B',
					tie: 'T',
				}[round.winner];

				return `<span class="scoreboard-dot ${colorClass}" title="${this.formatWinner(round.winner)}">${label}</span>`;
			})
			.join('');

		container.innerHTML = dotsHTML;
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

	private getSuitSymbol(suit: string): string {
		const symbols: Record<string, string> = {
			hearts: '♥',
			diamonds: '♦',
			clubs: '♣',
			spades: '♠',
		};
		return symbols[suit] || suit;
	}

	private getSuitColor(suit: string): string {
		return suit === 'hearts' || suit === 'diamonds' ? 'text-red-500' : 'text-neutral-900';
	}

	private formatBetType(type: BetType): string {
		const labels: Record<BetType, string> = {
			player: 'Player',
			banker: 'Banker',
			tie: 'Tie',
			playerPair: 'P. Pair',
			bankerPair: 'B. Pair',
		};
		return labels[type] || type;
	}

	private formatWinner(winner: string): string {
		return winner.charAt(0).toUpperCase() + winner.slice(1) + ' Wins!';
	}

	private formatPairs(playerPair: boolean, bankerPair: boolean): string {
		const pairs = [];
		if (playerPair) pairs.push('Player Pair');
		if (bankerPair) pairs.push('Banker Pair');
		return pairs.join(' | ');
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
