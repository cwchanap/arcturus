/**
 * PokerUIRenderer - Handles all DOM manipulation and UI updates
 */

import type { Card, Player, Suit } from './types';

export class PokerUIRenderer {
	private getSuitSymbol(suit: Suit): string {
		const symbols = {
			hearts: '♥',
			diamonds: '♦',
			clubs: '♣',
			spades: '♠',
		};
		return symbols[suit];
	}

	public renderPlayerCards(humanPlayer: Player, communityCards: Card[]) {
		const container = document.getElementById('player-cards');
		if (!container) return;

		container.innerHTML = humanPlayer.hand
			.map(
				(card) => `
			<div class="playing-card w-20 h-28 flex items-center justify-center">
				<div class="w-full h-full p-2 flex flex-col">
					<div class="text-xl font-bold ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
						${card.value}
					</div>
					<div class="flex-1 flex items-center justify-center text-4xl ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
						${this.getSuitSymbol(card.suit)}
					</div>
					<div class="text-xl font-bold text-right ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'} rotate-180">
						${card.value}
					</div>
				</div>
			</div>
		`,
			)
			.join('');

		this.evaluateHand(humanPlayer, communityCards);
	}

	public renderCommunityCards(communityCards: Card[]) {
		const container = document.getElementById('community-cards');
		if (!container) return;

		const cards: (Card | null)[] = [...communityCards];
		while (cards.length < 5) {
			cards.push(null);
		}

		container.innerHTML = cards
			.map((card) => {
				if (!card) {
					return `
					<div class="w-20 h-28 bg-slate-800/50 rounded-lg border-2 border-dashed border-slate-600 flex items-center justify-center text-slate-600">
						?
					</div>
				`;
				}
				return `
				<div class="playing-card w-20 h-28 flex items-center justify-center">
					<div class="w-full h-full p-2 flex flex-col">
						<div class="text-xl font-bold ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
							${card.value}
						</div>
						<div class="flex-1 flex items-center justify-center text-4xl ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
							${this.getSuitSymbol(card.suit)}
						</div>
						<div class="text-xl font-bold text-right ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'} rotate-180">
							${card.value}
						</div>
					</div>
				</div>
			`;
			})
			.join('');
	}

	public updateOpponentUI(players: Player[]) {
		// Update opponent chip counts using direct ID selectors
		if (players[1]) {
			const opponent1Chips = document.getElementById('opponent1-chips');
			if (opponent1Chips) {
				opponent1Chips.textContent = `$${players[1].chips}`;
			}
			// Update folded state
			this.updateFoldedState(1, players[1].folded);
		}
		if (players[2]) {
			const opponent2Chips = document.getElementById('opponent2-chips');
			if (opponent2Chips) {
				opponent2Chips.textContent = `$${players[2].chips}`;
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
					'folded-badge absolute top-0 right-0 bg-red-600 text-white text-xs px-2 py-1 rounded';
				badge.textContent = 'FOLDED';
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
				badge.className += ' bg-red-600 text-white';
				badge.textContent = '✕ FOLD';
				break;
			case 'check':
				badge.className += ' bg-blue-600 text-white';
				badge.textContent = '✓ CHECK';
				break;
			case 'call':
				badge.className += ' bg-green-600 text-white';
				badge.textContent = `✓ CALL $${amount || 0}`;
				break;
			case 'raise':
				badge.className += ' bg-yellow-600 text-white';
				badge.textContent = `↑ RAISE $${amount || 0}`;
				break;
			default:
				badge.className += ' bg-gray-600 text-white';
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
		// Reveal Player 2's hand (smaller cards for opponents)
		if (players[1] && !players[1].folded) {
			const opponent1Container = document.getElementById('opponent1-cards');
			if (opponent1Container) {
				const isWinner = winners.some((w) => w.id === players[1].id);
				opponent1Container.innerHTML = players[1].hand
					.map(
						(card) => `
					<div class="opponent-card-small playing-card ${isWinner ? 'ring-2 ring-yellow-400' : ''} w-12 h-16 flex items-center justify-center">
						<div class="w-full h-full p-1 flex flex-col">
							<div class="opponent-rank font-bold ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
								${card.value}
							</div>
							<div class="opponent-suit flex-1 flex items-center justify-center ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
								${this.getSuitSymbol(card.suit)}
							</div>
							<div class="opponent-rank font-bold text-right ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'} rotate-180">
								${card.value}
							</div>
						</div>
					</div>
				`,
					)
					.join('');
			}
		}

		// Reveal Player 3's hand (smaller cards for opponents)
		if (players[2] && !players[2].folded) {
			const opponent2Container = document.getElementById('opponent2-cards');
			if (opponent2Container) {
				const isWinner = winners.some((w) => w.id === players[2].id);
				opponent2Container.innerHTML = players[2].hand
					.map(
						(card) => `
					<div class="opponent-card-small playing-card ${isWinner ? 'ring-2 ring-yellow-400' : ''} w-12 h-16 flex items-center justify-center">
						<div class="w-full h-full p-1 flex flex-col">
							<div class="opponent-rank font-bold ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
								${card.value}
							</div>
							<div class="opponent-suit flex-1 flex items-center justify-center ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'}">
								${this.getSuitSymbol(card.suit)}
							</div>
							<div class="opponent-rank font-bold text-right ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'text-red-600' : 'text-gray-900'} rotate-180">
								${card.value}
							</div>
						</div>
					</div>
				`,
					)
					.join('');
			}
		}
	}

	public hideOpponentHands() {
		// Reset to face-down cards with smaller size for opponents
		const opponent1Container = document.getElementById('opponent1-cards');
		const opponent2Container = document.getElementById('opponent2-cards');

		const faceDownCard = `
			<div class="opponent-card-small playing-card w-12 h-16 flex items-center justify-center">
				<div class="w-full h-full bg-gradient-to-br from-blue-600 to-blue-800 rounded flex items-center justify-center">
					<div class="text-white opponent-back-icon">🂠</div>
				</div>
			</div>
		`;

		if (opponent1Container) {
			opponent1Container.innerHTML = faceDownCard + faceDownCard;
		}
		if (opponent2Container) {
			opponent2Container.innerHTML = faceDownCard + faceDownCard;
		}
	}

	private evaluateHand(humanPlayer: Player, communityCards: Card[]) {
		const strengthEl = document.getElementById('hand-strength');
		if (!strengthEl) return;

		const allCards = [...humanPlayer.hand, ...communityCards];
		if (allCards.length < 2) {
			strengthEl.textContent = '--';
			return;
		}

		// Simplified hand evaluation
		const values = allCards.map((c) => c.value);
		const suits = allCards.map((c) => c.suit);

		const valueCounts: Record<string, number> = {};
		values.forEach((v) => (valueCounts[v] = (valueCounts[v] || 0) + 1));

		const counts = Object.values(valueCounts).sort((a, b) => b - a);
		const isFlush = suits.every((s) => s === suits[0]) && suits.length >= 5;

		if (counts[0] === 4) strengthEl.textContent = 'Four of a Kind';
		else if (counts[0] === 3 && counts[1] === 2) strengthEl.textContent = 'Full House';
		else if (isFlush) strengthEl.textContent = 'Flush';
		else if (counts[0] === 3) strengthEl.textContent = 'Three of a Kind';
		else if (counts[0] === 2 && counts[1] === 2) strengthEl.textContent = 'Two Pair';
		else if (counts[0] === 2) strengthEl.textContent = 'Pair';
		else strengthEl.textContent = 'High Card';
	}

	public updateUI(pot: number, humanPlayer: Player) {
		const potEl = document.getElementById('pot-amount');
		const betEl = document.getElementById('current-bet');
		const balanceEl = document.getElementById('player-balance');

		if (potEl) potEl.textContent = `$${pot}`;
		if (betEl) betEl.textContent = `$${humanPlayer.currentBet}`;
		if (balanceEl) balanceEl.textContent = `$${humanPlayer.chips}`;
	}

	public updateGameStatus(message: string, gamePhase: string, pot: number) {
		const statusEl = document.getElementById('game-status');
		if (!statusEl) return;

		// Add phase and pot info to status message
		const phaseLabel = gamePhase.charAt(0).toUpperCase() + gamePhase.slice(1);
		const potInfo = pot > 0 ? ` | Pot: $${pot}` : '';
		statusEl.textContent = `[${phaseLabel}${potInfo}] ${message}`;
	}
}
