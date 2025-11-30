import { BlackjackGame } from './BlackjackGame';
import { GameSettingsManager } from './GameSettingsManager';
import {
	getBlackjackAdvice,
	getRoundCommentary,
	type LLMSettings,
	type BlackjackAdviceContext,
} from './llmBlackjackStrategy';
import { getHandValueDisplay } from './handEvaluator';
import type { RoundOutcome, RoundResult } from './types';

/**
 * Format outcome message for display, handling split hands.
 * Shows individual results for each hand when split, or single result otherwise.
 */
function formatOutcomeMessage(outcomes: RoundOutcome[]): string {
	if (outcomes.length === 1) {
		// Single hand - use simple message
		switch (outcomes[0].result) {
			case 'blackjack':
				return '🎉 BLACKJACK! You win!';
			case 'win':
				return '✓ You win!';
			case 'loss':
				return '✗ Dealer wins';
			case 'push':
				return '🤝 Push (Tie)';
		}
	}

	// Multiple hands (split) - show each hand's result
	const resultEmoji: Record<RoundResult, string> = {
		blackjack: '🎉',
		win: '✓',
		loss: '✗',
		push: '🤝',
	};
	const resultText: Record<RoundResult, string> = {
		blackjack: 'Blackjack',
		win: 'Win',
		loss: 'Loss',
		push: 'Push',
	};

	const handResults = outcomes
		.map((o, i) => `Hand ${i + 1}: ${resultEmoji[o.result]} ${resultText[o.result]}`)
		.join(' | ');

	// Determine overall result based on wins vs losses
	const wins = outcomes.filter((o) => o.result === 'win' || o.result === 'blackjack').length;
	const losses = outcomes.filter((o) => o.result === 'loss').length;

	let summary = '';
	if (wins > losses) {
		summary = ' — Overall: You win! 🎉';
	} else if (losses > wins) {
		summary = ' — Overall: Dealer wins';
	} else {
		summary = ' — Overall: Split result';
	}

	return handResults + summary;
}

/**
 * Get overall result for AI commentary based on all hand outcomes.
 * Returns the dominant result for split hands.
 */
function getOverallResult(outcomes: RoundOutcome[]): RoundResult {
	if (outcomes.length === 1) {
		return outcomes[0].result;
	}

	// For split hands, determine overall result based on wins vs losses
	const wins = outcomes.filter((o) => o.result === 'win' || o.result === 'blackjack').length;
	const losses = outcomes.filter((o) => o.result === 'loss').length;

	if (wins > losses) {
		// Check if any was blackjack
		const hasBlackjack = outcomes.some((o) => o.result === 'blackjack');
		return hasBlackjack ? 'blackjack' : 'win';
	} else if (losses > wins) {
		return 'loss';
	} else {
		return 'push';
	}
}

/**
 * Initialize Blackjack client-side UI and game logic.
 * This function wires up DOM elements, events, and LLM integration.
 */
export function initBlackjackClient(): void {
	// Initialize settings manager (per-user)
	const rootEl = document.getElementById('blackjack-root');
	const userId = rootEl?.getAttribute('data-user-id') ?? 'anonymous';
	const settingsManager = new GameSettingsManager(userId);
	let settings = settingsManager.getSettings();
	let dealerDelay = settingsManager.getDealerDelay();
	let llmUserEnabled = settings.useLLM;

	// Get initial balance from DOM; fall back to settings.startingChips if missing
	const balanceEl = document.getElementById('player-balance');
	const parsedBalance = parseInt(
		balanceEl?.textContent?.replace(/[^0-9]/g, '') || `${settings.startingChips}`,
		10,
	);
	const initialBalance = Number.isNaN(parsedBalance) ? settings.startingChips : parsedBalance;

	// Track the server-synced balance separately from game state.
	// This is the balance the server knows about, updated only after successful API calls.
	// Used for optimistic locking to avoid BALANCE_MISMATCH errors.
	let serverSyncedBalance = initialBalance;

	// Initialize game with configured bet limits
	const game = new BlackjackGame(initialBalance, settings.minBet, settings.maxBet);

	// LLM settings state
	let llmSettings: LLMSettings | null = null;
	let llmConfigured = false;

	// DOM elements (static Astro markup guarantees these exist when script runs)
	const bettingControls = document.getElementById('betting-controls') as HTMLElement;
	const gameControls = document.getElementById('game-controls') as HTMLElement;
	const betAmountInput = document.getElementById('bet-amount') as HTMLInputElement;
	const btnDeal = document.getElementById('btn-deal') as HTMLButtonElement;
	const btnHit = document.getElementById('btn-hit') as HTMLButtonElement;
	const btnStand = document.getElementById('btn-stand') as HTMLButtonElement;
	const btnDouble = document.getElementById('btn-double') as HTMLButtonElement;
	const btnSplit = document.getElementById('btn-split') as HTMLButtonElement;
	const btnNewRound = document.getElementById('btn-new-round') as HTMLButtonElement;
	const statusEl = document.getElementById('game-status') as HTMLElement;
	const balanceDisplay = document.getElementById('player-balance') as HTMLElement;

	// AI Rival DOM elements
	const btnAiRival = document.getElementById('btn-ai-rival') as HTMLButtonElement;
	const btnAiRivalText = document.getElementById('btn-ai-rival-text') as HTMLElement;
	const aiAdviceBox = document.getElementById('ai-advice-box') as HTMLElement;
	const aiAdviceAction = document.getElementById('ai-advice-action') as HTMLElement;
	const aiAdviceReasoning = document.getElementById('ai-advice-reasoning') as HTMLElement;
	const aiCommentaryBox = document.getElementById('ai-commentary-box') as HTMLElement;
	const aiCommentaryText = document.getElementById('ai-commentary-text') as HTMLElement;
	const llmConfigOverlay = document.getElementById('llm-config-overlay') as HTMLElement;
	const btnCloseOverlay = document.getElementById('btn-close-overlay') as HTMLButtonElement;

	// Settings panel elements (optional - may not exist on page)
	const btnToggleSettings = document.getElementById(
		'btn-toggle-settings',
	) as HTMLButtonElement | null;
	const settingsPanel = document.getElementById('settings-panel') as HTMLElement | null;
	const startingChipsInput = document.getElementById(
		'setting-starting-chips',
	) as HTMLInputElement | null;
	const minBetInput = document.getElementById('setting-min-bet') as HTMLInputElement | null;
	const maxBetInput = document.getElementById('setting-max-bet') as HTMLInputElement | null;
	const dealerSpeedSelect = document.getElementById(
		'setting-dealer-speed',
	) as HTMLSelectElement | null;
	const useLlmCheckbox = document.getElementById('setting-use-llm') as HTMLInputElement | null;
	const btnSaveSettings = document.getElementById('btn-save-settings') as HTMLButtonElement | null;
	const btnResetSettings = document.getElementById(
		'btn-reset-settings',
	) as HTMLButtonElement | null;

	// AI Rival status element
	const aiRivalStatus = document.getElementById('ai-rival-status') as HTMLElement | null;

	// Load LLM settings on page load
	async function loadLlmSettings() {
		try {
			const response = await fetch('/api/profile/llm-settings');
			if (!response.ok) {
				llmSettings = null;
				llmConfigured = false;
				updateAiRivalButtonState();
				return;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const data = (await response.json()) as any;
			const settings = data?.settings;

			if (
				settings &&
				(settings.provider === 'openai' || settings.provider === 'gemini') &&
				typeof settings.model === 'string'
			) {
				const apiKey =
					settings.provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey;

				if (apiKey && typeof apiKey === 'string' && apiKey.length > 0) {
					llmSettings = {
						provider: settings.provider,
						model: settings.model,
						apiKey: apiKey,
					};
					llmConfigured = true;
				} else {
					llmSettings = null;
					llmConfigured = false;
				}
			} else {
				llmSettings = null;
				llmConfigured = false;
			}
		} catch (_error) {
			llmSettings = null;
			llmConfigured = false;
		}
		updateAiRivalButtonState();
	}

	// Update AI Rival button state based on configuration
	function updateAiRivalButtonState() {
		if (llmConfigured) {
			btnAiRival.disabled = false;
			btnAiRival.classList.remove('opacity-50', 'cursor-not-allowed');
			if (aiRivalStatus) {
				aiRivalStatus.textContent = 'AI advisor ready';
				aiRivalStatus.classList.remove('text-slate-500');
				aiRivalStatus.classList.add('text-green-400');
			}
		} else {
			btnAiRival.disabled = true;
			btnAiRival.classList.add('opacity-50', 'cursor-not-allowed');
			if (aiRivalStatus) {
				aiRivalStatus.textContent = 'Configure API keys in profile to enable';
				aiRivalStatus.classList.remove('text-green-400');
				aiRivalStatus.classList.add('text-slate-500');
			}
		}
	}

	// Initialize LLM settings
	void loadLlmSettings();

	// Settings helpers
	function applyBetConstraints() {
		betAmountInput.min = settings.minBet.toString();
		betAmountInput.max = settings.maxBet.toString();

		const currentBet = parseInt(betAmountInput.value || '0', 10);
		if (Number.isNaN(currentBet) || currentBet < settings.minBet || currentBet > settings.maxBet) {
			betAmountInput.value = settings.minBet.toString();
		}
	}

	function renderSettingsForm() {
		if (
			!startingChipsInput ||
			!minBetInput ||
			!maxBetInput ||
			!dealerSpeedSelect ||
			!useLlmCheckbox
		)
			return;
		startingChipsInput.value = settings.startingChips.toString();
		minBetInput.value = settings.minBet.toString();
		maxBetInput.value = settings.maxBet.toString();
		dealerSpeedSelect.value = settings.dealerSpeed;
		useLlmCheckbox.checked = settings.useLLM;
	}

	// Settings panel toggle (only if elements exist)
	if (btnToggleSettings && settingsPanel) {
		btnToggleSettings.addEventListener('click', () => {
			settingsPanel.classList.toggle('hidden');
		});
	}

	// Save settings (only if elements exist)
	if (
		btnSaveSettings &&
		startingChipsInput &&
		minBetInput &&
		maxBetInput &&
		dealerSpeedSelect &&
		useLlmCheckbox
	) {
		btnSaveSettings.addEventListener('click', () => {
			const newStartingChips = parseInt(
				startingChipsInput.value || `${settings.startingChips}`,
				10,
			);
			const newMinBet = parseInt(minBetInput.value || `${settings.minBet}`, 10);
			const newMaxBet = parseInt(maxBetInput.value || `${settings.maxBet}`, 10);
			const newDealerSpeed = (dealerSpeedSelect.value || settings.dealerSpeed) as
				| 'slow'
				| 'normal'
				| 'fast';
			const newUseLlm = useLlmCheckbox.checked;

			if (Number.isNaN(newStartingChips) || newStartingChips <= 0) {
				statusEl.textContent = 'Starting chips must be a positive number.';
				return;
			}

			if (
				Number.isNaN(newMinBet) ||
				Number.isNaN(newMaxBet) ||
				newMinBet <= 0 ||
				newMaxBet <= 0 ||
				newMinBet >= newMaxBet
			) {
				statusEl.textContent = 'Minimum bet must be less than maximum bet and both positive.';
				return;
			}

			settingsManager.updateSettings({
				startingChips: newStartingChips,
				minBet: newMinBet,
				maxBet: newMaxBet,
				dealerSpeed: newDealerSpeed,
				useLLM: newUseLlm,
			});

			const previousStartingChips = settings.startingChips;
			settings = settingsManager.getSettings();
			dealerDelay = settingsManager.getDealerDelay();
			llmUserEnabled = settings.useLLM;

			// Update game instance bet limits so new rounds honor configured limits immediately
			game.updateBetLimits(settings.minBet, settings.maxBet);

			// Apply starting chips change if modified and currently in betting phase
			if (newStartingChips !== previousStartingChips) {
				const balanceUpdated = game.setBalance(newStartingChips);
				if (balanceUpdated) {
					// Update the synced balance tracker so chip sync doesn't revert it
					serverSyncedBalance = newStartingChips;
					// Re-render to show updated balance
					renderGame();
				}
			}

			applyBetConstraints();
			renderSettingsForm();

			statusEl.textContent = 'Settings saved. They will apply to new rounds.';
		});
	}

	// Reset settings (only if elements exist)
	if (btnResetSettings) {
		btnResetSettings.addEventListener('click', () => {
			settingsManager.resetToDefaults();
			settings = settingsManager.getSettings();
			dealerDelay = settingsManager.getDealerDelay();
			llmUserEnabled = settings.useLLM;

			applyBetConstraints();
			renderSettingsForm();

			statusEl.textContent = 'Settings reset to defaults.';
		});
	}

	applyBetConstraints();
	renderSettingsForm();

	// Quick bet buttons
	document.querySelectorAll<HTMLButtonElement>('.bet-quick').forEach((btn) => {
		btn.addEventListener('click', () => {
			const amount = btn.getAttribute('data-amount');
			if (amount) {
				betAmountInput.value = amount;
			}
		});
	});

	// Deal button
	btnDeal.addEventListener('click', () => {
		const betAmount = parseInt(betAmountInput.value);
		if (Number.isNaN(betAmount) || betAmount < settings.minBet || betAmount > settings.maxBet) {
			statusEl.textContent = `Bet must be between $${settings.minBet} and $${settings.maxBet}`;
			return;
		}

		if (betAmount > game.getBalance()) {
			statusEl.textContent = 'Insufficient balance';
			return;
		}

		try {
			game.placeBet(betAmount);
			game.deal();

			// Update UI
			renderGame();
			bettingControls.classList.add('hidden');
			gameControls.classList.remove('hidden');
			statusEl.textContent = 'Your turn - Hit or Stand?';

			const state = game.getState();
			if (state.phase === 'complete') {
				// Immediate blackjack or push
				setTimeout(() => {
					void handleRoundComplete();
				}, 500);
			}
		} catch (error) {
			statusEl.textContent = (error as Error).message;
		}
	});

	// Hit button
	btnHit.addEventListener('click', () => {
		try {
			game.hit();
			renderGame();

			const state = game.getState();
			if (state.phase === 'complete') {
				// Player busted
				setTimeout(() => {
					void handleRoundComplete();
				}, 500);
			}
		} catch (error) {
			statusEl.textContent = (error as Error).message;
		}
	});

	// Stand button
	btnStand.addEventListener('click', () => {
		try {
			game.stand();
			const stateAfter = game.getState();

			// Check if we moved to the next split hand or to dealer turn
			if (stateAfter.phase === 'player-turn') {
				// Still in player turn means there's another hand to play
				statusEl.textContent = `Playing hand ${stateAfter.activeHandIndex + 1} of ${stateAfter.playerHands.length}...`;
				renderGame();
			} else {
				// All hands complete, play dealer turn
				statusEl.textContent = 'Dealer playing...';
				renderGame();

				// Play dealer turn with delay for animation based on settings
				setTimeout(() => {
					game.playDealerTurn();
					renderGame();
					setTimeout(() => {
						void handleRoundComplete();
					}, dealerDelay);
				}, dealerDelay);
			}
		} catch (error) {
			statusEl.textContent = (error as Error).message;
		}
	});

	// Double Down button
	btnDouble.addEventListener('click', () => {
		try {
			game.doubleDown();
			const stateAfter = game.getState();

			// Check what phase we're in after double down
			if (stateAfter.phase === 'player-turn') {
				// Still in player turn means there's another split hand to play
				statusEl.textContent = `Playing hand ${stateAfter.activeHandIndex + 1} of ${stateAfter.playerHands.length}...`;
				renderGame();
			} else if (stateAfter.phase === 'complete') {
				// Busted on last hand - go straight to round complete
				renderGame();
				setTimeout(() => {
					void handleRoundComplete();
				}, dealerDelay);
			} else {
				// Dealer turn - play dealer
				statusEl.textContent = 'Dealer playing...';
				renderGame();

				// Play dealer turn with delay for animation based on settings
				setTimeout(() => {
					game.playDealerTurn();
					renderGame();
					setTimeout(() => {
						void handleRoundComplete();
					}, dealerDelay);
				}, dealerDelay);
			}
		} catch (error) {
			statusEl.textContent = (error as Error).message;
		}
	});

	// Split button
	btnSplit.addEventListener('click', () => {
		try {
			game.split();
			statusEl.textContent = 'Playing hand 1...';
			renderGame();
		} catch (error) {
			statusEl.textContent = (error as Error).message;
		}
	});

	// New round button
	btnNewRound.addEventListener('click', () => {
		game.startNewRound();
		renderGame();
		bettingControls.classList.remove('hidden');
		gameControls.classList.add('hidden');
		btnNewRound.classList.add('hidden');
		aiAdviceBox.classList.add('hidden');
		aiCommentaryBox.classList.add('hidden');

		// Reset card placeholders
		const playerCardsEl = document.getElementById('player-cards');
		const dealerCardsEl = document.getElementById('dealer-cards');
		if (playerCardsEl) {
			playerCardsEl.innerHTML = `
				<div class="card-placeholder"></div>
				<div class="card-placeholder"></div>
			`;
		}
		if (dealerCardsEl) {
			dealerCardsEl.innerHTML = `
				<div class="card-placeholder"></div>
				<div class="card-placeholder"></div>
			`;
		}

		statusEl.textContent = 'Place your bet to start';
	});

	// AI Rival button
	btnAiRival.addEventListener('click', async () => {
		const state = game.getState();

		// Check if we're in player turn
		if (state.phase !== 'player-turn') {
			return;
		}

		// Check if LLM feature is enabled in settings
		if (!llmUserEnabled) {
			statusEl.textContent = 'AI Rival is disabled in game settings.';
			return;
		}

		// Check if LLM is configured
		if (!llmConfigured) {
			llmConfigOverlay.classList.remove('hidden');
			return;
		}

		// Show loading state
		btnAiRival.disabled = true;
		btnAiRivalText.textContent = 'Thinking...';
		aiAdviceBox.classList.add('hidden');

		try {
			const activeHand = state.playerHands[state.activeHandIndex];
			const dealerUpCard = state.dealerHand.cards[0];

			const context: BlackjackAdviceContext = {
				playerHand: activeHand,
				dealerUpCard: dealerUpCard,
				availableActions: game.getAvailableActions(),
				playerBalance: game.getBalance(),
				currentBet: activeHand.bet,
			};

			const advice = await getBlackjackAdvice(context, llmSettings);

			const adviceIndicatesError =
				advice.reasoning.includes('LLM unavailable') ||
				advice.reasoning.includes('response could not be parsed');

			aiAdviceBox.classList.remove('hidden');
			if (adviceIndicatesError) {
				aiAdviceAction.textContent = 'Unable to get advice';
				aiAdviceReasoning.textContent = advice.reasoning;
				highlightRecommendedAction(null);
			} else {
				aiAdviceAction.textContent = advice.recommendedAction
					? `Recommended: ${advice.recommendedAction.toUpperCase()}`
					: 'No specific recommendation';
				aiAdviceReasoning.textContent = advice.reasoning;
				highlightRecommendedAction(advice.recommendedAction);
			}
		} catch (_error) {
			aiAdviceBox.classList.remove('hidden');
			aiAdviceAction.textContent = 'Unable to get advice';
			aiAdviceReasoning.textContent = 'Try again or play without AI assistance.';
		} finally {
			btnAiRival.disabled = false;
			btnAiRivalText.textContent = 'Ask AI Rival';
		}
	});

	// Close overlay button
	btnCloseOverlay.addEventListener('click', () => {
		llmConfigOverlay.classList.add('hidden');
	});

	// Highlight recommended action button
	function highlightRecommendedAction(action: string | null) {
		// Remove existing highlights
		[btnHit, btnStand, btnDouble, btnSplit].forEach((btn) => {
			btn.classList.remove('ring-2', 'ring-offset-2', 'ring-cyan-400');
		});

		if (!action) return;

		const buttonMap: Record<string, HTMLButtonElement> = {
			hit: btnHit,
			stand: btnStand,
			'double-down': btnDouble,
			split: btnSplit,
		};

		const targetBtn = buttonMap[action];
		if (targetBtn && !targetBtn.disabled) {
			targetBtn.classList.add('ring-2', 'ring-offset-2', 'ring-cyan-400');
		}
	}

	// Render a single playing card (similar to PlayingCard.astro)
	function renderPlayingCard(card: { rank: string; suit: string }): string {
		const suitSymbol = getSuitSymbol(card.suit);
		const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
		const colorClass = isRed ? 'card-red' : 'card-black';

		return `
			<div class="playing-card ${colorClass}">
				<div class="playing-card-inner">
					<div class="card-corner card-corner-top">
						<span class="card-rank">${card.rank}</span>
						<span class="card-suit-small">${suitSymbol}</span>
					</div>
					<span class="card-suit-center">${suitSymbol}</span>
					<div class="card-corner card-corner-bottom">
						<span class="card-rank">${card.rank}</span>
						<span class="card-suit-small">${suitSymbol}</span>
					</div>
				</div>
			</div>
		`;
	}

	// Render a face-down card
	function renderCardBack(): string {
		return `
			<div class="playing-card-back">
				<span class="card-back-icon">🎴</span>
			</div>
		`;
	}

	// Render game state
	function renderGame() {
		const state = game.getState();

		// Render player hand(s)
		const playerCardsEl = document.getElementById('player-cards');
		const playerValueEl = document.getElementById('player-value');
		const currentBetEl = document.getElementById('current-bet');

		if (!playerCardsEl || !playerValueEl || !currentBetEl) return;

		if (state.playerHands.length > 0) {
			// If split, show all hands with active hand highlighted
			if (state.playerHands.length > 1) {
				const handsHTML = state.playerHands
					.map((hand, index) => {
						const isActive = index === state.activeHandIndex;
						const containerClass = isActive ? 'active-hand' : 'inactive-hand';
						const cardsHTML = hand.cards.map((card) => renderPlayingCard(card)).join('');
						return `
							<div class="hand-container ${containerClass}">
								<div class="hand-label">Hand ${index + 1}</div>
								<div class="hand-cards">${cardsHTML}</div>
								<div class="hand-value">${getHandValueDisplay(hand.cards)}</div>
							</div>
						`;
					})
					.join('');
				playerCardsEl.innerHTML = handsHTML;
				playerValueEl.textContent = '';
				currentBetEl.textContent = `Bet per hand: $${state.playerHands[0].bet}`;
			} else {
				// Single hand - normal display
				const playerHand = state.playerHands[0];
				playerCardsEl.innerHTML = playerHand.cards.map((card) => renderPlayingCard(card)).join('');
				playerValueEl.textContent = getHandValueDisplay(playerHand.cards);
				currentBetEl.textContent = `Current Bet: $${playerHand.bet}`;
			}
		} else {
			// Show placeholders when no cards dealt
			playerCardsEl.innerHTML = `
				<div class="card-placeholder"></div>
				<div class="card-placeholder"></div>
			`;
			playerValueEl.textContent = '-';
			currentBetEl.textContent = 'Current Bet: $0';
		}

		// Render dealer hand
		const dealerCardsEl = document.getElementById('dealer-cards');
		const dealerValueEl = document.getElementById('dealer-value');
		if (!dealerCardsEl || !dealerValueEl) return;

		const hideCard = state.phase === 'player-turn' || state.phase === 'dealing';

		if (state.dealerHand.cards.length > 0) {
			const visibleCards = hideCard ? [state.dealerHand.cards[0]] : state.dealerHand.cards;

			dealerCardsEl.innerHTML =
				visibleCards.map((card) => renderPlayingCard(card)).join('') +
				(hideCard ? renderCardBack() : '');

			dealerValueEl.textContent = hideCard ? '?' : getHandValueDisplay(state.dealerHand.cards);
		} else {
			// Show placeholders when no cards dealt
			dealerCardsEl.innerHTML = `
				<div class="card-placeholder"></div>
				<div class="card-placeholder"></div>
			`;
			dealerValueEl.textContent = '-';
		}

		// Update balance
		balanceDisplay.textContent = `$${game.getBalance().toLocaleString()}`;

		// Update button states
		const actions = game.getAvailableActions();
		btnHit.disabled = !actions.includes('hit');
		btnStand.disabled = !actions.includes('stand');
		btnDouble.disabled = !actions.includes('double-down');
		btnSplit.disabled = !actions.includes('split');
	}

	// Handle round completion
	async function handleRoundComplete() {
		// IMPORTANT: Capture state BEFORE settleRound() because settleRound() mutates/clears hands.
		// We need the pre-settlement playerHands for AI commentary.
		const state = game.getState();
		const outcomes = game.settleRound();

		// Aggregate outcomes for split hands
		const message = formatOutcomeMessage(outcomes);
		statusEl.textContent = message;

		// Hide advice box and clear highlights
		aiAdviceBox.classList.add('hidden');
		highlightRecommendedAction(null);

		// Get AI commentary if configured
		if (llmConfigured && llmSettings) {
			try {
				// For split hands, use the overall result for commentary
				const overallResult = getOverallResult(outcomes);
				const playerHand = state.playerHands[0];
				const dealerHand = state.dealerHand;
				const commentary = await getRoundCommentary(
					playerHand,
					dealerHand,
					overallResult,
					llmSettings,
				);

				// Show commentary briefly
				aiCommentaryText.textContent = commentary;
				aiCommentaryBox.classList.remove('hidden');

				// Auto-hide after 4 seconds
				setTimeout(() => {
					aiCommentaryBox.classList.add('hidden');
				}, 4000);
			} catch (_error) {
				// Silently fail - commentary is optional
			}
		}

		// Update balance in database
		try {
			const newBalance = game.getBalance();
			// Delta is the net change from what the server knows about
			const delta = newBalance - serverSyncedBalance;
			const response = await fetch('/api/chips/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					previousBalance: serverSyncedBalance, // Use server-synced balance for optimistic locking
					delta, // Server computes newBalance from its own previousBalance + delta
					gameType: 'blackjack',
					maxBet: settings.maxBet, // Send configured max bet so server can validate delta appropriately
				}),
			});

			if (response.ok) {
				// Update our server-synced balance tracker after successful sync
				serverSyncedBalance = newBalance;
			} else {
				const errorData = await response.json();
				if (errorData.error === 'BALANCE_MISMATCH' && errorData.currentBalance !== undefined) {
					// Server has a different balance - sync to it
					serverSyncedBalance = errorData.currentBalance;
					console.warn('Balance mismatch detected, synced to server balance:', serverSyncedBalance);
				}
			}
		} catch (error) {
			console.error('Failed to update balance:', error);
		}

		// Show new round button
		btnNewRound.classList.remove('hidden');
		renderGame();
	}

	// Helper functions
	function getSuitSymbol(suit: string): string {
		const symbols: Record<string, string> = {
			hearts: '♥',
			diamonds: '♦',
			clubs: '♣',
			spades: '♠',
		};
		return symbols[suit] || suit;
	}

	// Initial render
	renderGame();
}
