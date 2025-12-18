/**
 * PokerGame class - Main game controller for Texas Hold'em
 * Refactored to use specialized helper classes
 */

import type { Card, Player, BettingRound, GameContext } from './types';
import type { AIConfig } from './aiStrategy';
import {
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
import { GameSettingsManager } from './GameSettingsManager';
import { makeLLMDecision, clearLLMCache } from './llmAIStrategy';

export class PokerGame {
	// Helper classes
	private deck: DeckManager;
	private ui: PokerUIRenderer;
	private aiRival: AIRivalAssistant;
	private settingsManager: GameSettingsManager;

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
	private pendingChipReset = false; // Flag to reset chips on next deal

	constructor() {
		this.deck = new DeckManager();
		this.ui = new PokerUIRenderer();
		this.aiRival = new AIRivalAssistant();
		this.settingsManager = new GameSettingsManager();

		this.initPlayers();
		this.attachEventListeners();
		this.attachSettingsListeners();
		this.renderSettingsPanel();
		this.updateBetControls(); // Initialize bet controls based on settings
		this.aiRival.highlightSuggestedMove(null);

		// On load, if LLM AI is enabled but no key is configured, show overlay immediately
		void this.checkLlmConfigOnLoad();
	}

	/**
	 * Check LLM configuration once on page load.
	 * If LLM AI is enabled but no valid key is configured, show the overlay and
	 * prevent the user from starting LLM-powered games until resolved.
	 */
	private async checkLlmConfigOnLoad() {
		const settings = this.settingsManager.getSettings();
		if (!settings.useLLMAI) {
			return;
		}

		const llmSettings = await this.getLLMSettings();
		if (!llmSettings) {
			// Inform via status and show the overlay card
			this.updateGameStatus(
				'LLM AI is enabled but no valid API key is configured. Update your profile settings or disable LLM in Game Settings.',
			);
			const overlay = document.getElementById('llm-overlay');
			if (overlay) {
				overlay.classList.remove('hidden');
			}
		}
	}

	private initPlayers() {
		const settings = this.settingsManager.getSettings();
		this.players = [
			createPlayer(0, 'You', settings.startingChips, false),
			createAIPlayer(1, 'Player 2', settings.startingChips),
			createAIPlayer(2, 'Player 3', settings.startingChips),
		];
		this.players[this.dealerIndex].isDealer = true;

		// Assign AI personalities from settings
		this.aiConfigs.set(1, createAIConfig(settings.aiPersonality1));
		this.aiConfigs.set(2, createAIConfig(settings.aiPersonality2));

		// Update blinds from settings
		this.minimumBet = settings.bigBlind;
		this.lastRaiseAmount = settings.bigBlind;
	}

	/**
	 * Get LLM settings from user profile for AI opponents
	 * Returns null if not configured or LLM AI is disabled
	 */
	private async getLLMSettings(): Promise<{
		provider: 'openai' | 'gemini';
		apiKey: string;
		model: string;
	} | null> {
		try {
			const response = await fetch('/api/profile/llm-settings');
			if (!response.ok) {
				return null;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const data = (await response.json()) as any;
			const settings = data?.settings;
			if (!settings || (settings.provider !== 'openai' && settings.provider !== 'gemini')) {
				return null;
			}

			const apiKey = settings.provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey;

			if (!apiKey || typeof apiKey !== 'string') {
				return null;
			}

			// Use provider-specific default models
			const defaultModel = settings.provider === 'openai' ? 'gpt-4o' : 'gemini-1.5-pro';

			return {
				provider: settings.provider,
				apiKey,
				model: typeof settings.model === 'string' ? settings.model : defaultModel,
			};
		} catch (error) {
			console.error('Failed to load LLM settings:', error);
			return null;
		}
	}

	public async dealNewHand() {
		// Clear LLM cache for new hand
		clearLLMCache();

		// If LLM-powered AI is enabled, ensure the user has a valid API key configured
		const llmAwareSettings = this.settingsManager.getSettings();
		if (llmAwareSettings.useLLMAI) {
			const llmSettings = await this.getLLMSettings();
			if (!llmSettings) {
				this.updateGameStatus(
					'LLM AI is enabled but no valid API key is configured. Update your profile settings to start a new game.',
				);

				// Show non-intrusive overlay on the table instead of using a popup
				const overlay = document.getElementById('llm-overlay');
				if (overlay) {
					overlay.classList.remove('hidden');
				}

				return;
			}
		}

		// Check for eliminated players (0 chips)
		const settings = this.settingsManager.getSettings();

		// Apply pending chip reset if settings were changed
		if (this.pendingChipReset) {
			this.players = this.players.map((p) => ({ ...p, chips: settings.startingChips }));
			this.pendingChipReset = false;
			this.updateGameStatus(`Chip stacks reset to $${settings.startingChips} for new game`);
		}

		const eliminatedPlayers = this.players.filter((p) => p.chips === 0);
		if (eliminatedPlayers.length > 0) {
			for (const player of eliminatedPlayers) {
				if (player.id === 0) {
					// Human player eliminated - offer rebuy
					const rebuy = confirm(`You're out of chips! Rebuy for $${settings.startingChips}?`);
					if (rebuy) {
						this.players[0] = { ...this.players[0], chips: settings.startingChips };
					} else {
						this.updateGameStatus('Game Over - You ran out of chips!');
						return; // Stop the game
					}
				} else {
					// AI player eliminated - auto rebuy
					this.players[player.id] = { ...this.players[player.id], chips: settings.startingChips };
					this.updateGameStatus(`${player.name} rebuys for $${settings.startingChips}`);
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

		// Reset players for new hand (preserves chips from previous hands)
		this.players = this.players.map(resetPlayerForNewHand);

		// Deal 2 cards to each player
		for (let i = 0; i < this.players.length; i++) {
			const card1 = this.deck.drawCard();
			const card2 = this.deck.drawCard();
			this.players[i] = dealCardsToPlayer(this.players[i], [card1, card2]);
		}

		// Reset community cards
		this.communityCards = [];

		// Post blinds using settings
		this.players[this.smallBlindIndex] = postBlind(
			this.players[this.smallBlindIndex],
			settings.smallBlind,
		);
		this.players[this.bigBlindIndex] = postBlind(
			this.players[this.bigBlindIndex],
			settings.bigBlind,
		);

		// Set game state
		this.pot = calculatePot(this.players);
		this.gamePhase = 'preflop';
		this.bettingRound = 'preflop';
		this.minimumBet = settings.bigBlind;
		this.lastRaiseAmount = settings.bigBlind;

		// Start with player after big blind
		this.currentPlayerIndex = (this.bigBlindIndex + 1) % this.players.length;

		// Render UI
		this.ui.hideOpponentHands(); // Hide opponent cards for new hand
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

		// AI decision delay based on settings
		const aiDelay = this.settingsManager.getAIDelay();
		const delay = aiDelay.min + Math.random() * (aiDelay.max - aiDelay.min);
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

		// Get AI decision (LLM or rule-based)
		const settings = this.settingsManager.getSettings();
		let decision;

		if (settings.useLLMAI) {
			// Try LLM-based AI with fallback to rule-based
			const llmSettings = await this.getLLMSettings();
			decision = await makeLLMDecision(context, aiConfig.personality, llmSettings);
		} else {
			// Use rule-based AI
			decision = makeAIDecision(context, aiConfig);
		}

		// Execute decision
		const highestBet = getHighestBet(this.players);
		const callAmount = getCallAmount(currentPlayer, highestBet);

		// Validate decision legality - prevent checking when facing a bet
		if (decision.action === 'check' && callAmount > 0) {
			// Illegal check - convert to call or fold
			console.warn(
				`${currentPlayer.name} attempted illegal check with callAmount=$${callAmount}, converting to call/fold`,
			);
			decision = {
				...decision,
				action: callAmount <= currentPlayer.chips ? 'call' : 'fold',
				reasoning: `${decision.reasoning} (illegal check converted)`,
			};
		}

		switch (decision.action) {
			case 'fold':
				this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
				this.updateGameStatus(`${currentPlayer.name} folds`);
				this.ui.showAIDecision(currentPlayer.id, 'fold');
				break;

			case 'check':
				this.players[this.currentPlayerIndex] = { ...currentPlayer, hasActed: true };
				this.updateGameStatus(`${currentPlayer.name} checks`);
				this.ui.showAIDecision(currentPlayer.id, 'check');
				break;

			case 'call':
				if (callAmount > 0 && callAmount <= currentPlayer.chips) {
					this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
					this.pot = calculatePot(this.players);
					this.updateGameStatus(`${currentPlayer.name} calls $${callAmount}`);
					this.ui.showAIDecision(currentPlayer.id, 'call', callAmount);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// Can't afford to call, fold instead
					this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
					this.updateGameStatus(`${currentPlayer.name} folds`);
					this.ui.showAIDecision(currentPlayer.id, 'fold');
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
					this.ui.showAIDecision(currentPlayer.id, 'raise', raiseAmount);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// Can't afford to raise, call instead
					if (callAmount > 0 && callAmount <= currentPlayer.chips) {
						this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
						this.pot = calculatePot(this.players);
						this.updateGameStatus(`${currentPlayer.name} calls $${callAmount}`);
						this.ui.showAIDecision(currentPlayer.id, 'call', callAmount);
						this.ui.updateUI(this.pot, this.players[0]);
						this.ui.updateOpponentUI(this.players);
					} else {
						this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
						this.updateGameStatus(`${currentPlayer.name} folds`);
						this.ui.showAIDecision(currentPlayer.id, 'fold');
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

				// Reveal opponent hands at showdown
				this.ui.revealOpponentHands(this.players, winners);

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
			const callAmount = getCallAmount(this.players[0], highestBet);
			// UX note: This "Check" action will effectively become a "Call" when callAmount > 0.
			// Consider updating the button label dynamically ("Call" when a bet must be matched),
			// or disabling Check when calling is required to avoid confusing players.

			this.isProcessingAction = true;
			try {
				if (callAmount > 0) {
					this.players[0] = placeBet(this.players[0], callAmount);
					this.pot = calculatePot(this.players);
					this.ui.updateUI(this.pot, this.players[0]);
					this.updateGameStatus(`You called $${callAmount}`);
				} else {
					this.players[0] = { ...this.players[0], hasActed: true };
					this.updateGameStatus('You checked');
				}
			} finally {
				setTimeout(() => {
					this.isProcessingAction = false;
					this.advanceTurn();
				}, 200);
			}
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

	private attachSettingsListeners() {
		// Toggle settings panel
		document.getElementById('btn-toggle-settings')?.addEventListener('click', () => {
			const panel = document.getElementById('settings-panel');
			if (panel) {
				panel.classList.toggle('hidden');
			}
		});

		// Save settings
		document.getElementById('btn-save-settings')?.addEventListener('click', () => {
			const startingChipsEl = document.getElementById(
				'setting-starting-chips',
			) as HTMLInputElement | null;
			const smallBlindEl = document.getElementById(
				'setting-small-blind',
			) as HTMLInputElement | null;
			const bigBlindEl = document.getElementById('setting-big-blind') as HTMLInputElement | null;
			const aiSpeedEl = document.getElementById('setting-ai-speed') as HTMLSelectElement | null;
			const aiPersonality1El = document.getElementById(
				'setting-ai-personality-1',
			) as HTMLSelectElement | null;
			const aiPersonality2El = document.getElementById(
				'setting-ai-personality-2',
			) as HTMLSelectElement | null;
			const useLLMAIEl = document.getElementById('setting-use-llm-ai') as HTMLInputElement | null;

			// Validate all required elements are present
			if (
				!startingChipsEl ||
				!smallBlindEl ||
				!bigBlindEl ||
				!aiSpeedEl ||
				!aiPersonality1El ||
				!aiPersonality2El ||
				!useLLMAIEl
			) {
				console.error('Settings form is missing required elements');
				this.updateGameStatus('Error: Settings form is incomplete. Please refresh the page.');
				return;
			}

			// Parse and validate values
			const startingChips = parseInt(startingChipsEl.value || '500');
			const smallBlind = parseInt(smallBlindEl.value || '5');
			const bigBlind = parseInt(bigBlindEl.value || '10');
			const aiSpeed = (aiSpeedEl.value || 'normal') as 'slow' | 'normal' | 'fast';
			const aiPersonality1 = (aiPersonality1El.value || 'tight-aggressive') as
				| 'tight-aggressive'
				| 'loose-aggressive'
				| 'tight-passive'
				| 'loose-passive';
			const aiPersonality2 = (aiPersonality2El.value || 'loose-aggressive') as
				| 'tight-aggressive'
				| 'loose-aggressive'
				| 'tight-passive'
				| 'loose-passive';
			const useLLMAI = useLLMAIEl.checked;

			this.settingsManager.updateSettings({
				startingChips,
				smallBlind,
				bigBlind,
				aiSpeed,
				aiPersonality1,
				aiPersonality2,
				useLLMAI,
			});

			// Update AI configs
			this.aiConfigs.set(1, createAIConfig(aiPersonality1));
			this.aiConfigs.set(2, createAIConfig(aiPersonality2));

			// Mark that chips should be reset on next deal
			this.pendingChipReset = true;

			// Update bet controls to reflect new minimum bet
			this.updateBetControls();

			// Notify user
			this.updateGameStatus('Settings saved! Start a new hand to apply changes.');

			// Hide settings panel
			document.getElementById('settings-panel')?.classList.add('hidden');
		});

		// Reset settings
		document.getElementById('btn-reset-settings')?.addEventListener('click', () => {
			this.settingsManager.resetToDefaults();
			this.renderSettingsPanel();

			// Update AI configs to match reset defaults
			const defaults = this.settingsManager.getSettings();
			this.aiConfigs.set(1, createAIConfig(defaults.aiPersonality1));
			this.aiConfigs.set(2, createAIConfig(defaults.aiPersonality2));

			// Mark that chips should be reset on next deal
			this.pendingChipReset = true;

			// Update bet controls to reflect reset minimum bet
			this.updateBetControls();

			this.updateGameStatus('Settings reset to defaults');
		});
	}

	private renderSettingsPanel() {
		const settings = this.settingsManager.getSettings();

		// Get elements with proper typing
		const startingChipsInput = document.getElementById(
			'setting-starting-chips',
		) as HTMLInputElement | null;
		const smallBlindInput = document.getElementById(
			'setting-small-blind',
		) as HTMLInputElement | null;
		const bigBlindInput = document.getElementById('setting-big-blind') as HTMLInputElement | null;
		const aiSpeedSelect = document.getElementById('setting-ai-speed') as HTMLSelectElement | null;
		const aiPersonality1Select = document.getElementById(
			'setting-ai-personality-1',
		) as HTMLSelectElement | null;
		const aiPersonality2Select = document.getElementById(
			'setting-ai-personality-2',
		) as HTMLSelectElement | null;
		const useLLMAICheckbox = document.getElementById(
			'setting-use-llm-ai',
		) as HTMLInputElement | null;

		// Update form values with null checks
		if (startingChipsInput) startingChipsInput.value = settings.startingChips.toString();
		if (smallBlindInput) smallBlindInput.value = settings.smallBlind.toString();
		if (bigBlindInput) bigBlindInput.value = settings.bigBlind.toString();
		if (aiSpeedSelect) aiSpeedSelect.value = settings.aiSpeed;
		if (aiPersonality1Select) aiPersonality1Select.value = settings.aiPersonality1;
		if (aiPersonality2Select) aiPersonality2Select.value = settings.aiPersonality2;
		if (useLLMAICheckbox) useLLMAICheckbox.checked = settings.useLLMAI;
	}

	private updateBetControls() {
		const settings = this.settingsManager.getSettings();
		const minBet = settings.bigBlind;

		// Update bet slider to use minimum bet from settings
		const betSlider = document.getElementById('bet-slider') as HTMLInputElement | null;
		if (betSlider) {
			betSlider.min = minBet.toString();
			betSlider.step = minBet.toString();
			betSlider.value = (minBet * 2).toString(); // Default to 2x big blind

			// Update bet amount display
			const betAmount = document.getElementById('bet-amount');
			if (betAmount) {
				betAmount.textContent = `$${minBet * 2}`;
			}
		}

		// Update quick-bet chips based on big blind
		const quickBetButtons = document.querySelectorAll('.quick-bet-chip');
		const multipliers = [1, 2.5, 5, 10]; // Multiples of big blind
		quickBetButtons.forEach((btn, index) => {
			const amount = Math.round(minBet * multipliers[index]);
			(btn as HTMLElement).dataset.amount = amount.toString();

			// Update chip display text (PokerChip renders a div.poker-chip)
			const chipDisplay = btn.querySelector('.poker-chip');
			if (chipDisplay) {
				chipDisplay.textContent = `$${amount}`;
			}
		});
	}
}
