/**
 * PokerGame class - Main game controller for Texas Hold'em
 * Refactored to use specialized helper classes
 */

import type { Card, Player, BettingRound, GameContext } from './types';
import type { AIConfig } from './aiStrategy';
import {
	STARTING_CHIPS,
	SMALL_BLIND,
	BIG_BLIND,
	createPlayer,
	createAIPlayer,
	placeBet,
	postBlind,
	foldPlayer,
	resetPlayerForNewHand,
	resetCurrentBets,
	dealCardsToPlayer,
	awardChips,
	getActivePlayers,
	getNextPlayerIndex,
	isBettingRoundComplete,
	getHighestBet,
	getCallAmount,
	calculatePot,
	distributePot,
	determineShowdownWinners,
	createAIConfig,
	makeAIDecision,
} from './index';
import { DeckManager } from './DeckManager';
import { PokerUIRenderer } from './PokerUIRenderer';
import { AIRivalAssistant } from './AIRivalAssistant';

export class PokerGame {
	// Helper classes
	private deck: DeckManager;
	private ui: PokerUIRenderer;
	private aiRival: AIRivalAssistant;

	// Game state
	private players: Player[] = [];
	private communityCards: Card[] = [];
	private pot = 0;
	private gamePhase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' = 'preflop';
	private bettingRound: BettingRound | null = null;
	private currentPlayerIndex = 0;
	private dealerIndex = 0;
	private smallBlindIndex = 1;
	private bigBlindIndex = 2;
	private minimumBet = BIG_BLIND;
	private lastRaiseAmount = BIG_BLIND;
	private isProcessingAction = false;
	private aiConfigs: Map<number, AIConfig> = new Map();

	constructor() {
		this.deck = new DeckManager();
		this.ui = new PokerUIRenderer();
		this.aiRival = new AIRivalAssistant();

		this.initPlayers();
		this.attachEventListeners();
		this.aiRival.highlightSuggestedMove(null);
	}

	private initPlayers() {
		this.players = [
			createPlayer(0, 'You', STARTING_CHIPS, false),
			createAIPlayer(1, 'Player 2', STARTING_CHIPS),
			createAIPlayer(2, 'Player 3', STARTING_CHIPS),
		];
		this.players[this.dealerIndex].isDealer = true;

		// Assign AI personalities
		this.aiConfigs.set(1, createAIConfig('tight-aggressive'));
		this.aiConfigs.set(2, createAIConfig('loose-aggressive'));
	}

	public dealNewHand() {
		// Check for eliminated players (0 chips)
		const eliminatedPlayers = this.players.filter((p) => p.chips === 0);
		if (eliminatedPlayers.length > 0) {
			for (const player of eliminatedPlayers) {
				if (player.id === 0) {
					// Human player eliminated - offer rebuy
					const rebuy = confirm(`You're out of chips! Rebuy for $${STARTING_CHIPS}?`);
					if (rebuy) {
						this.players[0] = { ...this.players[0], chips: STARTING_CHIPS };
					} else {
						this.updateGameStatus('Game Over - You ran out of chips!');
						return; // Stop the game
					}
				} else {
					// AI player eliminated - auto rebuy
					this.players[player.id] = { ...this.players[player.id], chips: STARTING_CHIPS };
					this.updateGameStatus(`${player.name} rebuys for $${STARTING_CHIPS}`);
				}
			}
		}

		// Rotate dealer button clockwise
		this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
		this.smallBlindIndex = (this.dealerIndex + 1) % this.players.length;
		this.bigBlindIndex = (this.dealerIndex + 2) % this.players.length;

		// Update dealer flag on players
		this.players = this.players.map((p) => ({ ...p, isDealer: false }));
		this.players[this.dealerIndex] = { ...this.players[this.dealerIndex], isDealer: true };

		// Reset deck and shuffle
		this.deck.reset();

		// Reset players for new hand
		this.players = this.players.map(resetPlayerForNewHand);

		// Deal 2 cards to each player
		for (let i = 0; i < this.players.length; i++) {
			const card1 = this.deck.drawCard();
			const card2 = this.deck.drawCard();
			this.players[i] = dealCardsToPlayer(this.players[i], [card1, card2]);
		}

		// Reset community cards
		this.communityCards = [];

		// Post blinds
		this.players[this.smallBlindIndex] = postBlind(this.players[this.smallBlindIndex], SMALL_BLIND);
		this.players[this.bigBlindIndex] = postBlind(this.players[this.bigBlindIndex], BIG_BLIND);

		// Set game state
		this.pot = calculatePot(this.players);
		this.gamePhase = 'preflop';
		this.bettingRound = 'preflop';
		this.minimumBet = BIG_BLIND;
		this.lastRaiseAmount = BIG_BLIND;

		// Start with player after big blind
		this.currentPlayerIndex = (this.bigBlindIndex + 1) % this.players.length;

		// Render UI
		this.ui.renderPlayerCards(this.players[0], this.communityCards);
		this.ui.renderCommunityCards(this.communityCards);
		this.ui.updateOpponentUI(this.players);
		this.ui.updateUI(this.pot, this.players[0]);
		this.aiRival.highlightSuggestedMove(null);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus('Your turn! Check, Call, Raise, or Fold');
		} else {
			this.updateGameStatus(`Waiting for ${this.players[this.currentPlayerIndex].name}...`);
			this.processAITurn();
		}
	}

	private async processAITurn() {
		if (this.isProcessingAction) return;
		if (this.currentPlayerIndex === 0) return; // Not AI's turn

		const currentPlayer = this.players[this.currentPlayerIndex];
		if (!currentPlayer || !currentPlayer.isAI) return;

		// Random delay for AI decision (800-1500ms)
		const delay = 800 + Math.random() * 700;
		await new Promise((resolve) => setTimeout(resolve, delay));

		// Get AI config
		const aiConfig = this.aiConfigs.get(currentPlayer.id);
		if (!aiConfig) {
			// Fallback: just check/fold
			const highestBet = getHighestBet(this.players);
			const callAmount = getCallAmount(currentPlayer, highestBet);
			if (callAmount === 0) {
				this.updateGameStatus(`${currentPlayer.name} checks`);
			} else {
				this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
				this.updateGameStatus(`${currentPlayer.name} folds`);
			}
			this.advanceTurn();
			return;
		}

		// Build game context for AI
		const context: GameContext = {
			player: currentPlayer,
			players: this.players,
			communityCards: this.communityCards,
			pot: this.pot,
			minimumBet: this.minimumBet,
			phase: this.gamePhase,
			bettingRound: this.bettingRound,
			position: this.getPlayerPosition(currentPlayer),
		};

		// Get AI decision
		const decision = makeAIDecision(context, aiConfig);

		// Execute decision
		const highestBet = getHighestBet(this.players);
		const callAmount = getCallAmount(currentPlayer, highestBet);

		switch (decision.action) {
			case 'fold':
				this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
				this.updateGameStatus(`${currentPlayer.name} folds`);
				break;

			case 'check':
				this.players[this.currentPlayerIndex] = { ...currentPlayer, hasActed: true };
				this.updateGameStatus(`${currentPlayer.name} checks`);
				break;

			case 'call':
				if (callAmount > 0 && callAmount <= currentPlayer.chips) {
					this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
					this.pot = calculatePot(this.players);
					this.updateGameStatus(`${currentPlayer.name} calls $${callAmount}`);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// Can't afford to call, fold instead
					this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
					this.updateGameStatus(`${currentPlayer.name} folds`);
				}
				break;

			case 'raise': {
				const raiseAmount = decision.amount || this.minimumBet;
				const totalBet = highestBet + raiseAmount;
				const amountToAdd = totalBet - currentPlayer.currentBet;

				if (amountToAdd <= currentPlayer.chips) {
					this.players[this.currentPlayerIndex] = placeBet(currentPlayer, amountToAdd);
					this.lastRaiseAmount = raiseAmount;
					this.minimumBet = raiseAmount;
					this.pot = calculatePot(this.players);
					this.updateGameStatus(`${currentPlayer.name} raises $${raiseAmount}`);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// Can't afford to raise, call instead
					if (callAmount > 0 && callAmount <= currentPlayer.chips) {
						this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
						this.pot = calculatePot(this.players);
						this.updateGameStatus(`${currentPlayer.name} calls $${callAmount}`);
						this.ui.updateUI(this.pot, this.players[0]);
						this.ui.updateOpponentUI(this.players);
					} else {
						this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
						this.updateGameStatus(`${currentPlayer.name} folds`);
					}
				}
				break;
			}

			default:
				break;
		}

		this.advanceTurn();
	}

	private advanceTurn() {
		// Check if betting round is complete
		if (isBettingRoundComplete(this.players)) {
			// Move to next phase
			setTimeout(() => this.nextPhase(), 1000);
			return;
		}

		// Move to next player
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.currentPlayerIndex);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus('Your turn!');
		} else {
			this.updateGameStatus(`Waiting for ${this.players[this.currentPlayerIndex].name}...`);
			this.processAITurn();
		}
	}

	private getPlayerPosition(player: Player): 'early' | 'middle' | 'late' {
		const dealerIndex = this.dealerIndex;
		const playerIndex = this.players.findIndex((p) => p.id === player.id);
		const positionFromDealer =
			(playerIndex - dealerIndex + this.players.length) % this.players.length;

		if (positionFromDealer <= 1) {
			return 'early';
		} else if (positionFromDealer === 2) {
			return 'middle';
		} else {
			return 'late';
		}
	}

	private updateGameStatus(message: string) {
		this.ui.updateGameStatus(message, this.gamePhase, this.pot);
	}

	private nextPhase() {
		// Check if only one player remains (everyone else folded)
		const activePlayers = getActivePlayers(this.players);
		if (activePlayers.length === 1) {
			const winner = activePlayers[0];
			this.players[winner.id] = awardChips(winner, this.pot);
			this.updateGameStatus(`${winner.name} wins $${this.pot}! (Everyone else folded) 🎉`);
			this.pot = 0;
			this.ui.updateUI(this.pot, this.players[0]);
			this.ui.updateOpponentUI(this.players);
			setTimeout(() => this.dealNewHand(), 3000);
			return;
		}

		// Reset current bets for new betting round
		this.players = this.players.map(resetCurrentBets);

		if (this.gamePhase === 'preflop') {
			this.gamePhase = 'flop';
			this.bettingRound = 'flop';
			this.communityCards.push(this.deck.drawCard(), this.deck.drawCard(), this.deck.drawCard());
			this.updateGameStatus('Flop revealed!');
		} else if (this.gamePhase === 'flop') {
			this.gamePhase = 'turn';
			this.bettingRound = 'turn';
			this.communityCards.push(this.deck.drawCard());
			this.updateGameStatus('Turn card revealed!');
		} else if (this.gamePhase === 'turn') {
			this.gamePhase = 'river';
			this.bettingRound = 'river';
			this.communityCards.push(this.deck.drawCard());
			this.updateGameStatus('River card revealed!');
		} else if (this.gamePhase === 'river') {
			this.gamePhase = 'showdown';
			this.bettingRound = null;
			// Determine winner(s) by comparing hands
			const activePlayers = getActivePlayers(this.players);
			if (activePlayers.length === 1) {
				// Only one player left - they win by default
				const winner = activePlayers[0];
				this.players[winner.id] = awardChips(winner, this.pot);
				this.updateGameStatus(`${winner.name} wins $${this.pot}! 🎉`);
			} else {
				// Multiple players - compare hands to find winner(s)
				const winners = determineShowdownWinners(activePlayers, this.communityCards);
				if (winners.length === 1) {
					// Single winner
					const winner = winners[0];
					this.players[winner.id] = awardChips(winner, this.pot);
					this.updateGameStatus(`${winner.name} wins $${this.pot}! 🎉`);
				} else {
					// Tie - split pot (remainder chips go to first winner(s))
					const distribution = distributePot(winners, this.pot);
					for (const [playerId, amount] of distribution.entries()) {
						const player = this.players.find((p) => p.id === playerId);
						if (player) {
							this.players[playerId] = awardChips(player, amount);
						}
					}
					const winnerNames = winners.map((w) => w.name).join(', ');
					this.updateGameStatus(`Tie! ${winnerNames} split the $${this.pot} pot 🤝`);
				}
			}
			this.pot = 0;
			this.ui.updateUI(this.pot, this.players[0]);
			this.ui.updateOpponentUI(this.players);
			// Auto-deal new hand after 3 seconds
			setTimeout(() => this.dealNewHand(), 3000);
			return;
		}

		// Start new betting round from dealer
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.dealerIndex);

		this.ui.renderCommunityCards(this.communityCards);
		this.ui.renderPlayerCards(this.players[0], this.communityCards);
		this.ui.updateUI(this.pot, this.players[0]);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus('Your turn!');
		} else {
			this.updateGameStatus(`Waiting for ${this.players[this.currentPlayerIndex].name}...`);
			this.processAITurn();
		}
	}

	private attachEventListeners() {
		document.getElementById('btn-deal')?.addEventListener('click', () => this.dealNewHand());

		document.getElementById('btn-fold')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			this.isProcessingAction = true;

			try {
				this.players[0] = foldPlayer(this.players[0]);
				this.ui.updateUI(this.pot, this.players[0]);
				this.updateGameStatus('You folded');
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		document.getElementById('btn-check')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			const highestBet = getHighestBet(this.players);
			if (this.players[0].currentBet < highestBet) return; // Can't check if there's a bet

			this.isProcessingAction = true;
			try {
				this.players[0] = { ...this.players[0], hasActed: true };
				this.updateGameStatus('You checked');
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		document.getElementById('btn-call')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			this.isProcessingAction = true;

			try {
				const highestBet = getHighestBet(this.players);
				const callAmount = getCallAmount(this.players[0], highestBet);

				if (callAmount > 0) {
					this.players[0] = placeBet(this.players[0], callAmount);
					this.pot = calculatePot(this.players);
					this.ui.updateUI(this.pot, this.players[0]);
					this.updateGameStatus(`You called $${callAmount}`);
				}
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		document.getElementById('btn-raise')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			this.isProcessingAction = true;

			try {
				const raiseAmount = parseInt(
					(document.getElementById('bet-slider') as HTMLInputElement).value,
				);
				const highestBet = getHighestBet(this.players);
				const totalBet = highestBet + raiseAmount;
				const amountToAdd = totalBet - this.players[0].currentBet;
				this.players[0] = placeBet(this.players[0], amountToAdd);
				this.lastRaiseAmount = raiseAmount;
				this.minimumBet = raiseAmount;
				this.pot = calculatePot(this.players);
				this.ui.updateUI(this.pot, this.players[0]);
				this.updateGameStatus(`You raised $${raiseAmount}`);
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		const betSlider = document.getElementById('bet-slider') as HTMLInputElement;
		const betAmount = document.getElementById('bet-amount');
		betSlider?.addEventListener('input', (e) => {
			const value = (e.target as HTMLInputElement).value;
			if (betAmount) betAmount.textContent = `$${value}`;
		});

		// Quick bet chips
		document.querySelectorAll('.quick-bet-chip').forEach((btn) => {
			btn.addEventListener('click', (e) => {
				const amount = (e.currentTarget as HTMLElement).dataset.amount;
				if (amount && betSlider) {
					betSlider.value = amount;
					if (betAmount) betAmount.textContent = `$${amount}`;
				}
			});
		});

		document.getElementById('btn-ai-move')?.addEventListener('click', () => {
			void this.aiRival.requestAiMove(
				this.gamePhase,
				this.players[0],
				this.communityCards,
				this.pot,
				this.players,
				(message: string) => this.updateGameStatus(message),
			);
		});
	}
}
