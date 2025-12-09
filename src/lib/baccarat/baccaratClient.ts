/**
 * BaccaratClient - Client-side game orchestration
 * Coordinates game logic with UI rendering and server sync
 */

import { BaccaratGame } from './BaccaratGame';
import { BaccaratUIRenderer } from './BaccaratUIRenderer';
import type { BaccaratGameConfig, BaccaratSettings, BetType, RoundOutcome, Card } from './types';

// Default UI selectors
const DEFAULT_SELECTORS = {
	playerHand: '#player-hand',
	bankerHand: '#banker-hand',
	activeBets: '#active-bets',
	roundResult: '#round-result',
	balance: '#chip-balance',
	shoeCount: '#shoe-count',
	scoreboard: '#scoreboard',
	status: '#game-status',
	dealButton: '#deal-button',
	newRoundButton: '#new-round-button',
	bettingArea: '#betting-area',
	insufficientChips: '#insufficient-chips-overlay',
};

export interface BaccaratClientConfig {
	initialBalance: number;
	settings?: Partial<BaccaratSettings>;
	selectors?: Partial<typeof DEFAULT_SELECTORS>;
	onBalanceSync?: (newBalance: number) => Promise<void>;
}

export class BaccaratClient {
	private game: BaccaratGame;
	private renderer: BaccaratUIRenderer;
	private selectors: typeof DEFAULT_SELECTORS;
	private onBalanceSync?: (newBalance: number) => Promise<void>;
	private currentBetAmount: number = 10;

	constructor(config: BaccaratClientConfig) {
		this.selectors = { ...DEFAULT_SELECTORS, ...config.selectors };
		this.onBalanceSync = config.onBalanceSync;
		this.renderer = new BaccaratUIRenderer();

		const gameConfig: BaccaratGameConfig = {
			initialBalance: config.initialBalance,
			settings: config.settings,
			events: {
				onBetPlaced: (bet) => this.handleBetPlaced(bet),
				onBetRemoved: (type) => this.handleBetRemoved(type),
				onDealStart: () => this.handleDealStart(),
				onCardDealt: (card, target, position) => this.handleCardDealt(card, target, position),
				onNatural: (hand, value) => this.handleNatural(hand, value),
				onThirdCard: (target, card) => this.handleThirdCard(target, card),
				onRoundComplete: (outcome) => this.handleRoundComplete(outcome),
				onBalanceUpdate: (balance) => this.handleBalanceUpdate(balance),
				onShoeReshuffle: () => this.handleShoeReshuffle(),
				onError: (error) => this.handleError(error),
			},
		};

		this.game = new BaccaratGame(gameConfig);

		// Apply animation speed setting
		if (config.settings?.animationSpeed) {
			this.renderer.setAnimationSpeed(config.settings.animationSpeed);
		}
	}

	/**
	 * Initialize the UI
	 */
	public initialize(): void {
		this.updateUI();
		this.bindEventListeners();
	}

	/**
	 * Place a bet
	 */
	public placeBet(type: BetType, amount?: number): boolean {
		const betAmount = amount ?? this.currentBetAmount;
		const result = this.game.placeBet(type, betAmount);
		if (!result.success) {
			this.showError(result.error ?? 'Failed to place bet');
			return false;
		}
		return true;
	}

	/**
	 * Remove a bet
	 */
	public removeBet(type: BetType): boolean {
		return this.game.removeBet(type);
	}

	/**
	 * Clear all bets
	 */
	public clearBets(): void {
		this.game.clearBets();
		this.updateBetsDisplay();
	}

	/**
	 * Set current bet amount
	 */
	public setBetAmount(amount: number): void {
		this.currentBetAmount = amount;
	}

	/**
	 * Deal cards and play round
	 */
	public async deal(): Promise<RoundOutcome | null> {
		if (!this.game.canDeal()) {
			this.showError('Place at least one bet to deal');
			return null;
		}

		this.renderer.setBettingEnabled(false, this.selectors.bettingArea);
		this.renderer.setDealButtonEnabled(false, this.selectors.dealButton);
		this.renderer.hideRoundResult(this.selectors.roundResult);

		const outcome = this.game.deal();

		if (!outcome) {
			this.renderer.setBettingEnabled(true, this.selectors.bettingArea);
			this.renderer.setDealButtonEnabled(true, this.selectors.dealButton);
			this.showError('Could not start round. Please try dealing again.');
			return null;
		}

		if (outcome) {
			// Sync balance with server
			await this.syncBalance();

			// Check for insufficient chips
			if (this.game.hasInsufficientChips()) {
				this.renderer.toggleInsufficientChipsOverlay(true, this.selectors.insufficientChips);
			}
		}

		return outcome;
	}

	/**
	 * Start a new round
	 */
	public newRound(): void {
		this.game.newRound();
		this.renderer.hideRoundResult(this.selectors.roundResult);
		this.renderer.setBettingEnabled(true, this.selectors.bettingArea);
		this.updateUI();
	}

	/**
	 * Get current game state
	 */
	public getState() {
		return this.game.getState();
	}

	/**
	 * Update settings
	 */
	public updateSettings(settings: Partial<BaccaratSettings>): void {
		this.game.updateSettings(settings);
		if (settings.animationSpeed) {
			this.renderer.setAnimationSpeed(settings.animationSpeed);
		}
	}

	// ===== Event Handlers =====

	private handleBetPlaced(_bet: { type: BetType; amount: number }): void {
		this.updateBetsDisplay();
		this.updateDealButton();
	}

	private handleBetRemoved(_type: BetType): void {
		this.updateBetsDisplay();
		this.updateDealButton();
	}

	private handleDealStart(): void {
		// Clear hands display
		this.renderer.renderPlayerHand({ cards: [] }, this.selectors.playerHand);
		this.renderer.renderBankerHand({ cards: [] }, this.selectors.bankerHand);
		this.renderer.showStatus('Dealing...', this.selectors.status);
	}

	private async handleCardDealt(
		card: Card,
		target: 'player' | 'banker',
		position: number,
	): Promise<void> {
		const selector = target === 'player' ? this.selectors.playerHand : this.selectors.bankerHand;
		const state = this.game.getState();
		const handCards =
			target === 'player' ? [...state.playerHand.cards] : [...state.bankerHand.cards];
		await this.renderer.addCardToHand(card, selector, position, handCards);
	}

	private handleNatural(hand: 'player' | 'banker', value: number): void {
		this.renderer.showStatus(
			`${hand === 'player' ? 'Player' : 'Banker'} Natural ${value}!`,
			this.selectors.status,
		);
	}

	private handleThirdCard(target: 'player' | 'banker', _card: unknown): void {
		this.renderer.showStatus(
			`${target === 'player' ? 'Player' : 'Banker'} draws third card`,
			this.selectors.status,
		);
	}

	private handleRoundComplete(outcome: RoundOutcome): void {
		this.renderer.hideStatus(this.selectors.status);
		this.renderer.renderRoundResult(outcome, this.selectors.roundResult);
		this.renderer.renderScoreboard(this.game.getState().roundHistory, this.selectors.scoreboard);
		this.updateBetsDisplay();
	}

	private handleBalanceUpdate(balance: number): void {
		this.renderer.updateBalance(balance, this.selectors.balance);
		this.renderer.updateShoeCount(
			this.game.getState().shoeCardsRemaining,
			this.selectors.shoeCount,
		);
	}

	private handleShoeReshuffle(): void {
		this.renderer.showStatus('Shuffling new shoe...', this.selectors.status);
	}

	private handleError(error: { code: string; message: string }): void {
		this.showError(error.message);
	}

	// ===== UI Updates =====

	private updateUI(): void {
		const state = this.game.getState();

		this.renderer.renderPlayerHand(state.playerHand, this.selectors.playerHand);
		this.renderer.renderBankerHand(state.bankerHand, this.selectors.bankerHand);
		this.renderer.updateBalance(state.chipBalance, this.selectors.balance);
		this.renderer.updateShoeCount(state.shoeCardsRemaining, this.selectors.shoeCount);
		this.renderer.renderScoreboard(state.roundHistory, this.selectors.scoreboard);
		this.updateBetsDisplay();
		this.updateDealButton();
	}

	private updateBetsDisplay(): void {
		const state = this.game.getState();
		this.renderer.renderBets(state.activeBets, this.selectors.activeBets);
	}

	private updateDealButton(): void {
		const canDeal = this.game.canDeal();
		this.renderer.setDealButtonEnabled(canDeal, this.selectors.dealButton);
	}

	private showError(message: string): void {
		// You could implement a toast notification here
		console.error('[Baccarat]', message);
		this.renderer.showStatus(message, this.selectors.status);
		setTimeout(() => this.renderer.hideStatus(this.selectors.status), 3000);
	}

	private async syncBalance(): Promise<void> {
		if (this.onBalanceSync) {
			try {
				await this.onBalanceSync(this.game.getBalance());
			} catch (error) {
				console.error('Balance sync failed:', error);
			}
		}
	}

	// ===== Event Binding =====

	private bindEventListeners(): void {
		// Deal button
		const dealButton = document.querySelector(this.selectors.dealButton);
		dealButton?.addEventListener('click', () => this.deal());

		// New round button
		const newRoundButton = document.querySelector(this.selectors.newRoundButton);
		newRoundButton?.addEventListener('click', () => this.newRound());

		// Bet area clicks
		this.bindBetAreaClick('player');
		this.bindBetAreaClick('banker');
		this.bindBetAreaClick('tie');
		this.bindBetAreaClick('playerPair');
		this.bindBetAreaClick('bankerPair');
	}

	private bindBetAreaClick(type: BetType): void {
		const betArea = document.querySelector(`[data-bet-type="${type}"]`);
		betArea?.addEventListener('click', () => this.placeBet(type));
	}
}
