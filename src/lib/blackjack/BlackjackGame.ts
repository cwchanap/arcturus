/**
 * BlackjackGame - Main game state manager
 * Supports: bet, deal, hit, stand, double down, split
 */

import type { BlackjackGameState, RoundOutcome, RoundResult, BlackjackAction, Hand } from './types';
import { DeckManager } from './DeckManager';
import { compareHands, isBlackjack, isBust, calculateHandValue } from './handEvaluator';
import { shouldDealerHit } from './dealerStrategy';
import { BLACKJACK_PAYOUT, WIN_PAYOUT, DEFAULT_MIN_BET, DEFAULT_MAX_BET } from './constants';

export class BlackjackGame {
	private state: BlackjackGameState;
	private deck: DeckManager;
	private minBet: number;
	private maxBet: number;

	constructor(initialBalance: number, minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET) {
		this.minBet = minBet;
		this.maxBet = maxBet;
		this.deck = new DeckManager();

		this.state = {
			phase: 'betting',
			playerHands: [],
			activeHandIndex: 0,
			dealerHand: { cards: [], bet: 0, isDealer: true },
			playerBalance: initialBalance,
			pot: 0,
		};
	}

	/**
	 * Get current game state (read-only)
	 *
	 * Note: This returns a *shallow* copy of the top-level state (the spread
	 * operator is used). Nested objects such as `playerHands`, `dealerHand`, and
	 * `cards` arrays still reference the internal state and may be mutated by
	 * callers. Consumers should treat nested data as read-only and must not
	 * modify it. If you require a fully independent deep snapshot, use
	 * {@link getDeepState} instead.
	 */
	public getState(): Readonly<BlackjackGameState> {
		return { ...this.state };
	}

	/**
	 * Get a deep-cloned copy of the current game state.
	 *
	 * Use this when you need a fully independent snapshot that can be safely
	 * mutated without affecting the internal game state. Uses `structuredClone`
	 * for deep copying.
	 */
	public getDeepState(): BlackjackGameState {
		return structuredClone(this.state);
	}

	/**
	 * Place a bet and initialize a new round
	 */
	public placeBet(amount: number): void {
		if (this.state.phase !== 'betting') {
			throw new Error('Can only place bet during betting phase');
		}

		if (amount < this.minBet || amount > this.maxBet) {
			throw new Error(`Bet must be between ${this.minBet} and ${this.maxBet}`);
		}

		if (amount > this.state.playerBalance) {
			throw new Error('Insufficient balance');
		}

		// Deduct bet from balance
		this.state.playerBalance -= amount;
		this.state.pot = amount;

		// Initialize player hand with bet
		this.state.playerHands = [
			{
				cards: [],
				bet: amount,
				isDealer: false,
			},
		];
		this.state.activeHandIndex = 0;

		// Reset dealer hand
		this.state.dealerHand = { cards: [], bet: 0, isDealer: true };

		// Move to dealing phase
		this.state.phase = 'dealing';
	}

	/**
	 * Deal initial cards (2 to player, 2 to dealer)
	 */
	public deal(): void {
		if (this.state.phase !== 'dealing') {
			throw new Error('Can only deal during dealing phase');
		}

		const playerHand = this.state.playerHands[0];

		// Deal 2 cards to player
		playerHand.cards.push(this.deck.deal());
		playerHand.cards.push(this.deck.deal());

		// Deal 2 cards to dealer
		this.state.dealerHand.cards.push(this.deck.deal());
		this.state.dealerHand.cards.push(this.deck.deal());

		// Check for immediate blackjack
		const playerBlackjack = isBlackjack(playerHand);
		const dealerBlackjack = isBlackjack(this.state.dealerHand);

		if (playerBlackjack || dealerBlackjack) {
			// Both have blackjack = push
			// Only player has blackjack = player wins 1.5x
			// Only dealer has blackjack = dealer wins
			this.state.phase = 'complete';
		} else {
			// Normal gameplay
			this.state.phase = 'player-turn';
		}
	}

	/**
	 * Player hits (receives another card)
	 */
	public hit(): void {
		if (this.state.phase !== 'player-turn') {
			throw new Error('Can only hit during player turn');
		}

		const activeHand = this.state.playerHands[this.state.activeHandIndex];
		activeHand.cards.push(this.deck.deal());

		// Check if busted
		if (isBust(activeHand)) {
			// Check if there are more split hands to play
			if (this.state.activeHandIndex < this.state.playerHands.length - 1) {
				this.state.activeHandIndex++;
			} else {
				// All hands complete (all busted or last hand busted)
				this.state.phase = 'complete';
			}
		}
	}

	/**
	 * Player stands (ends turn)
	 */
	public stand(): void {
		if (this.state.phase !== 'player-turn') {
			throw new Error('Can only stand during player turn');
		}

		// Check if there are more split hands to play
		if (this.state.activeHandIndex < this.state.playerHands.length - 1) {
			// Move to next hand
			this.state.activeHandIndex++;
		} else {
			// All hands complete, move to dealer turn
			this.state.phase = 'dealer-turn';
		}
	}

	/**
	 * Play dealer's turn (dealer draws according to rules)
	 */
	public playDealerTurn(): void {
		if (this.state.phase !== 'dealer-turn') {
			throw new Error('Can only play dealer turn during dealer-turn phase');
		}

		// Dealer draws until should stand
		while (shouldDealerHit(this.state.dealerHand)) {
			this.state.dealerHand.cards.push(this.deck.deal());
		}

		// Move to complete phase
		this.state.phase = 'complete';
	}

	/**
	 * Settle the round and calculate payouts
	 * Returns array of outcomes (one per hand)
	 */
	public settleRound(): RoundOutcome[] {
		if (this.state.phase !== 'complete') {
			throw new Error('Can only settle during complete phase');
		}

		const outcomes: RoundOutcome[] = [];
		const dealerHand = this.state.dealerHand;

		// Handle each player hand
		for (let i = 0; i < this.state.playerHands.length; i++) {
			const playerHand = this.state.playerHands[i];
			const bet = playerHand.bet;

			let result: RoundResult;
			let payout: number;

			const playerBlackjack = isBlackjack(playerHand);
			const dealerBlackjack = isBlackjack(dealerHand);
			const playerBust = isBust(playerHand);
			const dealerBust = isBust(dealerHand);

			if (playerBlackjack && dealerBlackjack) {
				// Both blackjack = push
				result = 'push';
				payout = bet; // Return bet
			} else if (playerBlackjack) {
				// Player blackjack wins 1.5x
				result = 'blackjack';
				// Keep chip balances integral: 3:2 profit can create half-chips on odd bets.
				// We round the profit portion down to the nearest whole chip.
				payout = bet + Math.floor(bet * BLACKJACK_PAYOUT);
			} else if (dealerBlackjack || playerBust) {
				// Dealer blackjack or player bust = loss
				result = 'loss';
				payout = 0;
			} else if (dealerBust) {
				// Dealer bust = player wins
				result = 'win';
				payout = bet + bet * WIN_PAYOUT;
			} else {
				// Compare hands
				const comparison = compareHands(playerHand, dealerHand);
				if (comparison > 0) {
					result = 'win';
					payout = bet + bet * WIN_PAYOUT;
				} else if (comparison < 0) {
					result = 'loss';
					payout = 0;
				} else {
					result = 'push';
					payout = bet; // Return bet
				}
			}

			// Update balance (keep integral)
			this.state.playerBalance = Math.trunc(this.state.playerBalance + payout);

			outcomes.push({
				handIndex: i,
				result,
				payout,
			});
		}

		// Reset for next round
		this.state.phase = 'betting';
		this.state.pot = 0;

		return outcomes;
	}

	/**
	 * Player doubles down (doubles bet, receives one card, automatically stands)
	 */
	public doubleDown(): void {
		if (this.state.phase !== 'player-turn') {
			throw new Error('Can only double down during player turn');
		}

		const activeHand = this.state.playerHands[this.state.activeHandIndex];

		// Validate: must have exactly 2 cards
		if (activeHand.cards.length !== 2) {
			throw new Error('Can only double down on initial 2-card hand');
		}

		// Validate: hand must total 9, 10, or 11
		const handValue = calculateHandValue(activeHand.cards);
		if (handValue.value < 9 || handValue.value > 11) {
			throw new Error('Can only double down on hand totaling 9, 10, or 11');
		}

		// Validate: player must have enough chips to double bet
		if (activeHand.bet > this.state.playerBalance) {
			throw new Error('Insufficient balance to double down');
		}

		// Double the bet
		this.state.playerBalance -= activeHand.bet;
		this.state.pot += activeHand.bet;
		activeHand.bet *= 2;

		// Deal one card
		activeHand.cards.push(this.deck.deal());

		// Check if busted or if there are more hands
		if (isBust(activeHand)) {
			// Check if there are more split hands to play
			if (this.state.activeHandIndex < this.state.playerHands.length - 1) {
				this.state.activeHandIndex++;
			} else {
				this.state.phase = 'complete';
			}
		} else {
			// Check if there are more split hands to play
			if (this.state.activeHandIndex < this.state.playerHands.length - 1) {
				this.state.activeHandIndex++;
			} else {
				this.state.phase = 'dealer-turn';
			}
		}
	}

	/**
	 * Player splits hand (creates two hands from a pair)
	 */
	public split(): void {
		if (this.state.phase !== 'player-turn') {
			throw new Error('Can only split during player turn');
		}

		const activeHand = this.state.playerHands[this.state.activeHandIndex];

		// Validate: must have exactly 2 cards
		if (activeHand.cards.length !== 2) {
			throw new Error('Can only split initial 2-card hand');
		}

		// Validate: both cards must be same rank
		if (activeHand.cards[0].rank !== activeHand.cards[1].rank) {
			throw new Error('Can only split pairs of same rank');
		}

		// Validate: player must have enough chips for second bet
		if (activeHand.bet > this.state.playerBalance) {
			throw new Error('Insufficient balance to split');
		}

		// Deduct second bet from balance
		this.state.playerBalance -= activeHand.bet;
		this.state.pot += activeHand.bet;

		// Create second hand with second card
		const secondCard = activeHand.cards.pop()!;
		const newHand: Hand = {
			cards: [secondCard],
			bet: activeHand.bet,
			isDealer: false,
		};

		// Deal one card to each hand
		activeHand.cards.push(this.deck.deal());
		newHand.cards.push(this.deck.deal());

		// Add new hand to player hands
		this.state.playerHands.push(newHand);

		// Continue playing first hand (activeHandIndex stays 0)
	}

	/**
	 * Move to next hand after current hand is complete
	 */
	public nextHand(): void {
		if (this.state.phase !== 'player-turn') {
			throw new Error('Can only move to next hand during player turn');
		}

		// Check if there are more hands to play
		if (this.state.activeHandIndex < this.state.playerHands.length - 1) {
			this.state.activeHandIndex++;
		} else {
			// All hands complete, move to dealer turn
			this.state.phase = 'dealer-turn';
		}
	}

	/**
	 * Get available actions for current game state
	 */
	public getAvailableActions(): BlackjackAction[] {
		if (this.state.phase !== 'player-turn') {
			return [];
		}

		const activeHand = this.state.playerHands[this.state.activeHandIndex];
		const actions: BlackjackAction[] = ['hit', 'stand'];

		// Double down available on 2-card hands totaling 9-11 with sufficient chips
		if (activeHand.cards.length === 2) {
			const handValue = calculateHandValue(activeHand.cards);
			if (
				handValue.value >= 9 &&
				handValue.value <= 11 &&
				activeHand.bet <= this.state.playerBalance
			) {
				actions.push('double-down');
			}

			// Split available on matching pairs with sufficient chips
			if (
				activeHand.cards[0].rank === activeHand.cards[1].rank &&
				activeHand.bet <= this.state.playerBalance
			) {
				actions.push('split');
			}
		}

		return actions;
	}

	/**
	 * Get detailed availability info for double-down and split actions.
	 * Returns reason why an action is unavailable for tooltip display.
	 */
	public getActionAvailability(): {
		doubleDown: { available: boolean; reason?: string };
		split: { available: boolean; reason?: string };
	} {
		const result = {
			doubleDown: { available: false, reason: undefined as string | undefined },
			split: { available: false, reason: undefined as string | undefined },
		};

		if (this.state.phase !== 'player-turn') {
			result.doubleDown.reason = 'Not your turn';
			result.split.reason = 'Not your turn';
			return result;
		}

		const activeHand = this.state.playerHands[this.state.activeHandIndex];
		const hasEnoughChips = activeHand.bet <= this.state.playerBalance;

		// Check double-down availability
		if (activeHand.cards.length !== 2) {
			result.doubleDown.reason = 'Only available on first two cards';
		} else {
			const handValue = calculateHandValue(activeHand.cards);
			if (handValue.value < 9 || handValue.value > 11) {
				result.doubleDown.reason = 'Only available on hands totaling 9-11';
			} else if (!hasEnoughChips) {
				result.doubleDown.reason = `Not enough chips (need $${activeHand.bet} more)`;
			} else {
				result.doubleDown.available = true;
			}
		}

		// Check split availability
		if (activeHand.cards.length !== 2) {
			result.split.reason = 'Only available on first two cards';
		} else if (activeHand.cards[0].rank !== activeHand.cards[1].rank) {
			result.split.reason = 'Only available on matching pairs';
		} else if (!hasEnoughChips) {
			result.split.reason = `Not enough chips (need $${activeHand.bet} more)`;
		} else {
			result.split.available = true;
		}

		return result;
	}

	/**
	 * Get current balance
	 */
	public getBalance(): number {
		return this.state.playerBalance;
	}

	/**
	 * Update bet limits (used when settings change)
	 */
	public updateBetLimits(minBet: number, maxBet: number): void {
		if (minBet > 0 && maxBet > 0 && minBet <= maxBet) {
			this.minBet = minBet;
			this.maxBet = maxBet;
		}
	}

	/**
	 * Set player balance (used when settings change starting chips)
	 * Only allowed during betting phase to prevent mid-round manipulation
	 */
	public setBalance(newBalance: number): boolean {
		if (this.state.phase !== 'betting') {
			return false; // Cannot change balance mid-round
		}
		if (newBalance >= 0) {
			this.state.playerBalance = newBalance;
			return true;
		}
		return false;
	}

	/**
	 * Start a new round (resets to betting phase)
	 * Also reshuffles deck if below threshold (never mid-hand)
	 */
	public startNewRound(): void {
		// Reshuffle at round start if needed (FR-006: never reshuffle mid-hand)
		this.deck.reshuffleIfNeeded();

		this.state.phase = 'betting';
		this.state.playerHands = [];
		this.state.dealerHand = { cards: [], bet: 0, isDealer: true };
		this.state.pot = 0;
		this.state.activeHandIndex = 0;
	}
}
