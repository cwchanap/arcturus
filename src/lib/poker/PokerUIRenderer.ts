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
		// Update opponent chip counts
		if (players[1]) {
			const opponent1Chips = document
				.querySelector('#opponent1-cards')
				?.parentElement?.querySelector('.text-xs.text-yellow-400');
			if (opponent1Chips) {
				opponent1Chips.textContent = `$${players[1].chips}`;
			}
		}
		if (players[2]) {
			const opponent2Chips = document
				.querySelector('#opponent2-cards')
				?.parentElement?.querySelector('.text-xs.text-yellow-400');
			if (opponent2Chips) {
				opponent2Chips.textContent = `$${players[2].chips}`;
			}
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
		document.getElementById('pot-amount')!.textContent = `$${pot}`;
		document.getElementById('current-bet')!.textContent = `$${humanPlayer.currentBet}`;

		// Update player balance in header
		const balanceEl = document.querySelector(
			'.bg-slate-800.px-6.py-3 .text-2xl.font-bold.text-yellow-400',
		);
		if (balanceEl) {
			balanceEl.textContent = `$${humanPlayer.chips}`;
		}
	}

	public updateGameStatus(message: string, gamePhase: string, pot: number) {
		// Add phase and pot info to status message
		const phaseLabel = gamePhase.charAt(0).toUpperCase() + gamePhase.slice(1);
		const potInfo = pot > 0 ? ` | Pot: $${pot}` : '';
		const fullMessage = `[${phaseLabel}${potInfo}] ${message}`;
		document.getElementById('game-status')!.textContent = fullMessage;
	}
}
