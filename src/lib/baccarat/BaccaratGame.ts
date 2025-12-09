/**
 * BaccaratGame - Main game state manager for Punto Banco Baccarat
 * Handles betting, dealing, third-card rules, and payout resolution
 */

import type {
	BaccaratGameConfig,
	BaccaratGameEvents,
	BaccaratGameState,
	BaccaratSettings,
	Bet,
	BetType,
	Card,
	RoundOutcome,
	Winner,
} from './types';
import { DeckManager } from './DeckManager';
import { getHandValue, isNatural, isPair, determineWinner, hasNatural } from './handEvaluator';
import { shouldPlayerDraw, shouldBankerDraw } from './thirdCardRules';
import { calculateAllPayouts, calculateTotalPayout } from './payoutCalculator';
import { DEFAULT_SETTINGS, MAX_HISTORY_LENGTH } from './constants';

export class BaccaratGame {
	private state: BaccaratGameState;
	private deck: DeckManager;
	private events: Partial<BaccaratGameEvents>;

	constructor(config: BaccaratGameConfig) {
		const settings: BaccaratSettings = {
			...DEFAULT_SETTINGS,
			...config.settings,
		};

		this.deck = new DeckManager();
		this.events = config.events ?? {};

		this.state = {
			phase: 'betting',
			playerHand: { cards: [] },
			bankerHand: { cards: [] },
			activeBets: [],
			chipBalance: config.initialBalance,
			roundHistory: [],
			shoeCardsRemaining: this.deck.remainingCards(),
			settings,
		};
	}

	/**
	 * Get current game state (shallow copy)
	 */
	public getState(): Readonly<BaccaratGameState> {
		return {
			...this.state,
			shoeCardsRemaining: this.deck.remainingCards(),
		};
	}

	/**
	 * Get a deep-cloned copy of the current game state
	 */
	public getDeepState(): BaccaratGameState {
		return structuredClone({
			...this.state,
			shoeCardsRemaining: this.deck.remainingCards(),
		});
	}

	// ===== Betting Phase Methods =====

	/**
	 * Place a bet on a specific outcome
	 */
	public placeBet(type: BetType, amount: number): { success: boolean; error?: string } {
		if (this.state.phase !== 'betting') {
			return { success: false, error: 'Can only place bets during betting phase' };
		}

		// Validate bet amount
		if (amount < this.state.settings.minBet) {
			return {
				success: false,
				error: `Minimum bet is ${this.state.settings.minBet}`,
			};
		}

		if (amount > this.state.settings.maxBet) {
			return {
				success: false,
				error: `Maximum bet is ${this.state.settings.maxBet}`,
			};
		}

		// Check total bets don't exceed balance
		const currentTotal = this.getBetTotal();
		if (currentTotal + amount > this.state.chipBalance) {
			return {
				success: false,
				error: `Insufficient balance. Available: ${this.state.chipBalance - currentTotal}`,
			};
		}

		// Check for existing bet on same type
		const existingBetIndex = this.state.activeBets.findIndex((b) => b.type === type);
		if (existingBetIndex >= 0) {
			const existingAmount = this.state.activeBets[existingBetIndex].amount;
			if (existingAmount + amount > this.state.settings.maxBet) {
				return {
					success: false,
					error: `Maximum bet is ${this.state.settings.maxBet}`,
				};
			}
			// Update existing bet
			this.state.activeBets[existingBetIndex].amount = existingAmount + amount;
		} else {
			// Add new bet
			const bet: Bet = { type, amount };
			this.state.activeBets.push(bet);
		}

		// Fire event
		const bet = this.state.activeBets.find((b) => b.type === type)!;
		this.events.onBetPlaced?.(bet);

		return { success: true };
	}

	/**
	 * Remove a bet by type
	 */
	public removeBet(type: BetType): boolean {
		if (this.state.phase !== 'betting') {
			return false;
		}

		const index = this.state.activeBets.findIndex((b) => b.type === type);
		if (index >= 0) {
			this.state.activeBets.splice(index, 1);
			this.events.onBetRemoved?.(type);
			return true;
		}
		return false;
	}

	/**
	 * Clear all bets
	 */
	public clearBets(): void {
		if (this.state.phase !== 'betting') {
			return;
		}

		const types = this.state.activeBets.map((b) => b.type);
		this.state.activeBets = [];
		types.forEach((type) => this.events.onBetRemoved?.(type));
	}

	/**
	 * Get total amount bet
	 */
	public getBetTotal(): number {
		return this.state.activeBets.reduce((sum, bet) => sum + bet.amount, 0);
	}

	/**
	 * Check if deal can proceed
	 */
	public canDeal(): boolean {
		return this.state.phase === 'betting' && this.state.activeBets.length > 0;
	}

	// ===== Game Flow Methods =====

	/**
	 * Deal cards and play out the round
	 * Returns the round outcome
	 */
	public deal(): RoundOutcome | null {
		if (!this.canDeal()) {
			this.events.onError?.({
				code: 'NO_BETS_PLACED',
				message: 'Place at least one bet to deal',
			});
			return null;
		}

		// Reshuffle if needed (at start of round, never mid-hand)
		if (this.deck.reshuffleIfNeeded()) {
			this.events.onShoeReshuffle?.();
		}

		// Deduct bets from balance
		const totalBet = this.getBetTotal();
		this.state.chipBalance -= totalBet;
		this.events.onBalanceUpdate?.(this.state.chipBalance);

		// Move to dealing phase
		this.state.phase = 'dealing';
		this.events.onDealStart?.();

		// Deal initial 4 cards: Player1, Banker1, Player2, Banker2
		this.state.playerHand = { cards: [] };
		this.state.bankerHand = { cards: [] };

		const p1 = this.deck.deal();
		this.state.playerHand.cards.push(p1);
		this.events.onCardDealt?.(p1, 'player', 0);

		const b1 = this.deck.deal();
		this.state.bankerHand.cards.push(b1);
		this.events.onCardDealt?.(b1, 'banker', 0);

		const p2 = this.deck.deal();
		this.state.playerHand.cards.push(p2);
		this.events.onCardDealt?.(p2, 'player', 1);

		const b2 = this.deck.deal();
		this.state.bankerHand.cards.push(b2);
		this.events.onCardDealt?.(b2, 'banker', 1);

		// Get initial hand values
		const playerValue = getHandValue(this.state.playerHand);
		const bankerValue = getHandValue(this.state.bankerHand);

		// Check for naturals
		if (hasNatural(this.state.playerHand, this.state.bankerHand)) {
			if (isNatural(this.state.playerHand)) {
				this.events.onNatural?.('player', playerValue);
			}
			if (isNatural(this.state.bankerHand)) {
				this.events.onNatural?.('banker', bankerValue);
			}
			// Skip to resolution
			return this.resolveRound();
		}

		// Third card rules
		let playerThirdCard: Card | null = null;
		const playerStood = !shouldPlayerDraw(playerValue);

		// Player third card
		if (!playerStood) {
			this.state.phase = 'playerThird';
			playerThirdCard = this.deck.deal();
			this.state.playerHand.cards.push(playerThirdCard);
			this.events.onThirdCard?.('player', playerThirdCard);
		}

		// Banker third card
		const newBankerValue = getHandValue(this.state.bankerHand);
		if (shouldBankerDraw(newBankerValue, playerThirdCard, playerStood)) {
			this.state.phase = 'bankerThird';
			const bankerThird = this.deck.deal();
			this.state.bankerHand.cards.push(bankerThird);
			this.events.onThirdCard?.('banker', bankerThird);
		}

		// Resolve round
		return this.resolveRound();
	}

	/**
	 * Resolve the round and process payouts
	 */
	private resolveRound(): RoundOutcome {
		this.state.phase = 'resolution';

		const playerValue = getHandValue(this.state.playerHand);
		const bankerValue = getHandValue(this.state.bankerHand);
		const winner = determineWinner(playerValue, bankerValue);

		const outcome: RoundOutcome = {
			winner,
			playerHand: { cards: [...this.state.playerHand.cards] },
			bankerHand: { cards: [...this.state.bankerHand.cards] },
			playerValue,
			bankerValue,
			playerPair: isPair(this.state.playerHand),
			bankerPair: isPair(this.state.bankerHand),
			isNatural: hasNatural(this.state.playerHand, this.state.bankerHand),
			betResults: [],
			timestamp: Date.now(),
		};

		// Calculate payouts
		outcome.betResults = calculateAllPayouts(this.state.activeBets, outcome);
		const netPayout = calculateTotalPayout(this.state.activeBets, outcome);

		// Update balance: add back original bets plus net winnings/losses
		// Net payout already accounts for wins (+) and losses (-)
		// For wins: we get back our bet + profit
		// For losses: we lose our bet (-bet.amount is in netPayout)
		// For push: we get back our bet (payout = 0)
		const totalBet = this.getBetTotal();
		this.state.chipBalance += totalBet + netPayout;
		this.events.onBalanceUpdate?.(this.state.chipBalance);

		// Add to history (keep last 20)
		this.state.roundHistory.unshift(outcome);
		if (this.state.roundHistory.length > MAX_HISTORY_LENGTH) {
			this.state.roundHistory.pop();
		}

		// Fire completion event
		this.events.onRoundComplete?.(outcome);

		return outcome;
	}

	/**
	 * Start a new round (reset to betting phase)
	 */
	public newRound(): void {
		this.state.phase = 'betting';
		this.state.playerHand = { cards: [] };
		this.state.bankerHand = { cards: [] };
		this.state.activeBets = [];
	}

	// ===== Query Methods =====

	/**
	 * Get the winner of the last completed round
	 */
	public getWinner(): Winner | null {
		if (this.state.roundHistory.length === 0) {
			return null;
		}
		return this.state.roundHistory[0].winner;
	}

	/**
	 * Get the last round outcome
	 */
	public getLastOutcome(): RoundOutcome | null {
		return this.state.roundHistory[0] ?? null;
	}

	/**
	 * Check if player has insufficient chips to continue
	 */
	public hasInsufficientChips(): boolean {
		return this.state.chipBalance < this.state.settings.minBet;
	}

	// ===== Settings Methods =====

	/**
	 * Update game settings
	 */
	public updateSettings(settings: Partial<BaccaratSettings>): void {
		this.state.settings = {
			...this.state.settings,
			...settings,
		};
	}

	/**
	 * Get current balance
	 */
	public getBalance(): number {
		return this.state.chipBalance;
	}

	/**
	 * Set balance (only during betting phase)
	 */
	public setBalance(newBalance: number): boolean {
		if (this.state.phase !== 'betting') {
			return false;
		}
		if (newBalance >= 0) {
			this.state.chipBalance = newBalance;
			this.events.onBalanceUpdate?.(newBalance);
			return true;
		}
		return false;
	}

	/**
	 * Get statistics from round history
	 */
	public getStatistics(): { player: number; banker: number; tie: number } {
		return this.state.roundHistory.reduce(
			(acc, outcome) => {
				acc[outcome.winner]++;
				return acc;
			},
			{ player: 0, banker: 0, tie: 0 },
		);
	}
}
