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
import { renderCardsToContainer, clearCardsContainer, setSlotState } from '../card-slot-utils';
import {
	clearPendingStats,
	createPendingStats,
	ensureRoundStatsIncluded,
	markSyncPendingOnRateLimit,
} from './balance-sync-stats';

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
	const isAnonymousUser = userId === 'anonymous';
	const settingsManager = new GameSettingsManager(userId);
	let settings = settingsManager.getSettings();
	let dealerDelay = settingsManager.getDealerDelay();
	let llmUserEnabled = settings.useLLM;

	// Get initial balance from DOM; fall back to settings.startingChips if missing
	const balanceEl = document.getElementById('player-balance');
	const rawBalanceText = balanceEl?.textContent ?? `${settings.startingChips}`;
	const normalizedBalanceText = rawBalanceText.replace(/,/g, '');
	const balanceMatch = normalizedBalanceText.match(/-?\d+(?:\.\d+)?/);
	const parsedBalance = balanceMatch ? Number(balanceMatch[0]) : Number.NaN;
	// Number.isFinite() rejects NaN and +/-Infinity, which is sufficient here (we only want a real
	// numeric balance; anything else falls back to settings.startingChips).
	const initialBalance = Number.isFinite(parsedBalance) ? parsedBalance : settings.startingChips;

	// Track the server-synced balance separately from game state.
	// This is the balance the server knows about, updated only after successful API calls.
	// Used for optimistic locking to avoid BALANCE_MISMATCH errors.
	let serverSyncedBalance = initialBalance;

	// Track pending stats from rounds where sync is delayed (e.g., rate-limited)
	// This prevents stats drift when multiple rounds are played before sync succeeds
	let pendingStats = createPendingStats();
	let syncPending = false;

	// Track pending retry timer to cancel stale retries before starting new sync
	let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

	// Initialize game with configured bet limits
	const game = new BlackjackGame(initialBalance, settings.minBet, settings.maxBet);

	// LLM settings state
	let llmSettings: LLMSettings | null = null;
	let llmConfigured = false;
	let llmSettingsLoading: Promise<void> | null = null;

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
				llmConfigOverlay.classList.add('hidden');
				llmConfigOverlay.classList.remove('flex');
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

		if (llmConfigured) {
			llmConfigOverlay.classList.remove('flex');
			llmConfigOverlay.classList.add('hidden');
		}
		updateAiRivalButtonState();
	}

	// Update AI Rival button state based on configuration
	// Note: Button stays clickable even when unconfigured so users can click
	// to see the overlay explaining how to configure API keys
	function updateAiRivalButtonState() {
		if (llmConfigured) {
			btnAiRival.classList.remove('opacity-50');
			if (aiRivalStatus) {
				aiRivalStatus.textContent = 'AI advisor ready';
				aiRivalStatus.classList.remove('text-slate-500');
				aiRivalStatus.classList.add('text-green-400');
			}
		} else {
			btnAiRival.classList.add('opacity-50');
			if (aiRivalStatus) {
				aiRivalStatus.textContent = 'Configure API keys in profile to enable';
				aiRivalStatus.classList.remove('text-green-400');
				aiRivalStatus.classList.add('text-slate-500');
			}
		}
	}

	// Initialize LLM settings
	const initialLlmSettingsLoad = loadLlmSettings();
	llmSettingsLoading = initialLlmSettingsLoad;
	void initialLlmSettingsLoad.finally(() => {
		if (llmSettingsLoading === initialLlmSettingsLoad) {
			llmSettingsLoading = null;
		}
	});

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

			// Starting chips is a *settings* value. For authenticated users, chip balance is
			// server-authoritative (to avoid rate-limit / optimistic-lock flakiness), so we do not
			// attempt to sync or overwrite the user's real balance here.
			// For anonymous/local sessions, apply it immediately to the in-memory game balance.
			if (isAnonymousUser && newStartingChips !== previousStartingChips) {
				const balanceUpdated = game.setBalance(newStartingChips);
				if (balanceUpdated) {
					serverSyncedBalance = newStartingChips;
					renderGame();
				}
			}

			applyBetConstraints();
			renderSettingsForm();

			if (!newUseLlm) {
				llmConfigOverlay.classList.add('hidden');
				llmConfigOverlay.classList.remove('flex');
			}
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

			// Update game instance bet limits so new rounds honor reset limits immediately
			game.updateBetLimits(settings.minBet, settings.maxBet);

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
				void handleRoundComplete();
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
		const singleHandContainer = document.getElementById('player-cards-single');
		const splitHandsContainer = document.getElementById('player-cards-split');
		singleHandContainer?.classList.remove('hidden');
		splitHandsContainer?.classList.add('hidden');
		splitHandsContainer?.classList.remove('flex');

		clearCardsContainer('player-cards', 2);
		clearCardsContainer('dealer-cards', 2);

		statusEl.textContent = 'Place your bet to start';
	});

	// AI Rival button
	btnAiRival.addEventListener('click', async () => {
		const state = game.getState();

		// Check if LLM feature is enabled in settings
		if (!llmUserEnabled) {
			statusEl.textContent = 'AI Rival is disabled in game settings.';
			llmConfigOverlay.classList.add('hidden');
			llmConfigOverlay.classList.remove('flex');
			return;
		}

		// Check if we're in player turn
		if (state.phase !== 'player-turn') {
			return;
		}

		// Check if LLM is configured
		// Note: Settings are loaded async on page load. If the user clicks before that finishes,
		// we should retry loading here instead of immediately showing the overlay.
		if (!llmConfigured) {
			// Potential race: repeated clicks before the first load resolves could start multiple
			// concurrent loadLlmSettings() calls. Consider guarding with llmSettingsLoading (in-flight
			// promise) so only one load runs at a time.
			const inFlight = llmSettingsLoading ?? loadLlmSettings();
			if (!llmSettingsLoading) {
				llmSettingsLoading = inFlight;
			}
			try {
				await inFlight;
			} catch (error) {
				console.error('Error loading LLM settings:', error);
				llmSettings = null;
				llmConfigured = false;
				updateAiRivalButtonState();
			} finally {
				if (llmSettingsLoading === inFlight) {
					llmSettingsLoading = null;
				}
			}
		}

		if (!llmConfigured) {
			llmConfigOverlay.classList.remove('hidden');
			llmConfigOverlay.classList.add('flex');
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
		llmConfigOverlay.classList.remove('flex');
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

	// Render game state
	function renderGame() {
		const state = game.getState();

		// Render player hand(s)
		const playerCardsEl = document.getElementById('player-cards');
		const playerValueEl = document.getElementById('player-value');
		const currentBetEl = document.getElementById('current-bet');

		if (!playerCardsEl || !playerValueEl || !currentBetEl) return;

		const singleHandContainer = document.getElementById('player-cards-single');
		const splitHandsContainer = document.getElementById('player-cards-split');

		if (state.playerHands.length > 0) {
			// If split, show split hands container
			if (state.playerHands.length > 1) {
				// Hide single hand, show split hands
				singleHandContainer?.classList.add('hidden');
				splitHandsContainer?.classList.remove('hidden');
				splitHandsContainer?.classList.add('flex');

				// Update each split hand
				const handContainers = splitHandsContainer?.querySelectorAll('[data-hand-index]');
				handContainers?.forEach((container, index) => {
					if (index < state.playerHands.length) {
						const hand = state.playerHands[index];
						const isActive = index === state.activeHandIndex;

						// Show this hand container
						container.classList.remove('hidden');
						container.classList.toggle('active-hand', isActive);
						container.classList.toggle('inactive-hand', !isActive);
						container.setAttribute('data-hand-active', String(isActive));

						// Update hand label
						const labelEl = container.querySelector('[data-hand-label]');
						if (labelEl) labelEl.textContent = `Hand ${index + 1}`;

						// Update hand value
						const valueEl = container.querySelector('[data-hand-value]');
						if (valueEl) valueEl.textContent = getHandValueDisplay(hand.cards);

						// Update hand bet
						const betEl = container.querySelector('[data-hand-bet]');
						if (betEl) betEl.textContent = `$${hand.bet}`;

						// Render cards to this hand's slots
						const cardSlots = container.querySelectorAll('.card-slot');
						cardSlots.forEach((slot, cardIndex) => {
							if (cardIndex < hand.cards.length) {
								setSlotState(slot, 'card', hand.cards[cardIndex]);
							} else {
								setSlotState(slot, 'hidden');
							}
						});
					} else {
						// Hide unused hand containers
						container.classList.add('hidden');
					}
				});

				playerValueEl.textContent = '';
				const activeHand = state.playerHands[state.activeHandIndex];
				currentBetEl.textContent = `Hand ${state.activeHandIndex + 1} Bet: $${activeHand.bet}`;
			} else {
				// Single hand - show single container, hide split
				singleHandContainer?.classList.remove('hidden');
				splitHandsContainer?.classList.add('hidden');
				splitHandsContainer?.classList.remove('flex');

				const playerHand = state.playerHands[0];
				renderCardsToContainer('player-cards', playerHand.cards, { showPlaceholders: 2 });
				playerValueEl.textContent = getHandValueDisplay(playerHand.cards);
				currentBetEl.textContent = `Current Bet: $${playerHand.bet}`;
			}
		} else {
			// Show placeholders when no cards dealt
			singleHandContainer?.classList.remove('hidden');
			splitHandsContainer?.classList.add('hidden');
			splitHandsContainer?.classList.remove('flex');
			clearCardsContainer('player-cards', 2);
			playerValueEl.textContent = '-';
			currentBetEl.textContent = 'Current Bet: $0';
		}

		// Render dealer hand
		const dealerCardsEl = document.getElementById('dealer-cards');
		const dealerValueEl = document.getElementById('dealer-value');
		if (!dealerCardsEl || !dealerValueEl) return;

		const hideCard = state.phase === 'player-turn' || state.phase === 'dealing';

		if (state.dealerHand.cards.length > 0) {
			// Render dealer cards with facedown option
			const facedownCount = hideCard ? 1 : 0;
			renderCardsToContainer('dealer-cards', state.dealerHand.cards, {
				showPlaceholders: 2,
				facedownCount,
			});
			dealerValueEl.textContent = hideCard ? '?' : getHandValueDisplay(state.dealerHand.cards);
		} else {
			// Show placeholders when no cards dealt
			clearCardsContainer('dealer-cards', 2);
			dealerValueEl.textContent = '-';
		}

		// Update balance
		balanceDisplay.textContent = `$${game.getBalance().toLocaleString()}`;

		// Update button states with dynamic tooltips
		const actions = game.getAvailableActions();
		const actionInfo = game.getActionAvailability();

		btnHit.disabled = !actions.includes('hit');
		btnStand.disabled = !actions.includes('stand');

		// Double-down button with explanatory tooltip
		btnDouble.disabled = !actions.includes('double-down');
		if (actionInfo.doubleDown.available) {
			btnDouble.title = 'Double your bet and receive one card';
		} else if (actionInfo.doubleDown.reason) {
			btnDouble.title = actionInfo.doubleDown.reason;
		}

		// Split button with explanatory tooltip
		btnSplit.disabled = !actions.includes('split');
		if (actionInfo.split.available) {
			btnSplit.title = 'Split your pair into two hands';
		} else if (actionInfo.split.reason) {
			btnSplit.title = actionInfo.split.reason;
		}
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

		// Show new round button immediately so UI/tests can detect completion.
		// Balance sync and optional commentary can continue asynchronously.
		btnNewRound.classList.remove('hidden');

		// Get AI commentary if configured
		if (llmConfigured && llmSettings) {
			try {
				// For split hands, use the overall result for commentary
				const overallResult = getOverallResult(outcomes);
				// Pass all player hands so commentary can describe split scenarios accurately
				const playerHands = state.playerHands;
				const dealerHand = state.dealerHand;
				const commentary = await getRoundCommentary(
					playerHands,
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
		// Flag to track whether current round stats have been included in pendingStats
		let statsIncluded = false;

		try {
			// NOTE: During async balance sync, we try to avoid overwriting the round-result message.
			// This is a heuristic based on matching the current status text; if the status is empty or
			// contains unexpected copy, this can fail and allow intermediate sync messages to appear.
			// Consider tracking an explicit "round just completed" flag in state instead of regex.
			const statusBeforeSync = statusEl.textContent || '';
			const preserveRoundResultStatus = /win|wins|Dealer wins|Push|BLACKJACK|Bust/i.test(
				statusBeforeSync,
			);
			const setStatusIfNotRoundResult = (message: string) => {
				if (!preserveRoundResultStatus) {
					statusEl.textContent = message;
				}
			};

			// Determine outcome for stats tracking
			// For split hands, count actual wins/losses per hand instead of using overall result
			const winsIncrement = outcomes.filter(
				(o) => o.result === 'win' || o.result === 'blackjack',
			).length;
			const lossesIncrement = outcomes.filter((o) => o.result === 'loss').length;
			// Pushes are tracked via handsIncrement, not sent to API separately
			const _pushesIncrement = outcomes.filter((o) => o.result === 'push').length;

			// Determine primary outcome for backward compatibility
			// Use overall result for non-split rounds, or derive from net result for split rounds
			const overallResult = getOverallResult(outcomes);
			const outcomeForStats =
				overallResult === 'blackjack' ? 'win' : (overallResult as 'win' | 'loss' | 'push');

			// Calculate biggest win for split-hand rounds
			// For split hands, we need to track maximum win per individual hand,
			// not total delta, to avoid conflating "split hands" with "aggregated multi-round sync"
			// The API uses handCount > 1 as a proxy for "aggregated sync", so we explicitly provide
			// biggestWinCandidate to override this for split-hand rounds
			let biggestWinCandidate: number | undefined;
			if (outcomes.length > 1) {
				// Split hand: calculate maximum win per hand
				// We need the original bets from state before settleRound mutated them
				const maxWin = Math.max(
					...outcomes.map((o) => {
						// Find the corresponding hand in the captured state to get the original bet
						const originalHand = state.playerHands[o.handIndex];
						// Profit = payout - original bet
						return o.payout - originalHand.bet;
					}),
				);
				biggestWinCandidate = maxWin > 0 ? maxWin : undefined;
			}

			// Helper to perform the chip update request
			const performChipUpdate = async (retryCount = 0): Promise<void> => {
				// Clear any pending retry timer from previous sync attempt to prevent stale deltas
				if (pendingRetryTimer) {
					clearTimeout(pendingRetryTimer);
					pendingRetryTimer = null;
				}

				// Recompute delta using current game balance (not stale cached delta)
				// This prevents double-applying deltas when a later round syncs before an earlier retry
				const currentGameBalance = game.getBalance();
				const deltaForRequest = currentGameBalance - serverSyncedBalance;

				// Include any pending stats from previous delayed syncs to prevent drift
				// If current round's stats haven't been included yet, add them now
				const roundStats = {
					winsIncrement,
					lossesIncrement,
					handsIncrement: outcomes.length,
				};
				({ pendingStats, statsIncluded } = ensureRoundStatsIncluded(
					pendingStats,
					roundStats,
					statsIncluded,
				));
				const finalWinsIncrement = pendingStats.winsIncrement;
				const finalLossesIncrement = pendingStats.lossesIncrement;
				const finalHandCount = pendingStats.handsIncrement;

				const response = await fetch('/api/chips/update', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						previousBalance: serverSyncedBalance,
						delta: deltaForRequest,
						gameType: 'blackjack',
						maxBet: settings.maxBet,
						outcome: outcomeForStats,
						handCount: finalHandCount,
						// Send accumulated stats including pending ones
						winsIncrement: finalWinsIncrement,
						lossesIncrement: finalLossesIncrement,
						// For split hands, send maximum per-hand win to avoid conflating with aggregated sync
						biggestWinCandidate,
					}),
				});

				if (response.ok) {
					// Clear pending stats on successful sync
					pendingStats = clearPendingStats();
					syncPending = false;
					statsIncluded = false;
					pendingRetryTimer = null;

					// Update our server-synced balance tracker after successful sync
					// Use the same balance reference that was used for the delta calculation
					serverSyncedBalance = currentGameBalance;
					if (retryCount > 0) {
						setStatusIfNotRoundResult('Balance synced successfully.');
					}

					// Check for newly earned achievements and warnings
					const data = (await response.json().catch(() => ({}))) as {
						newAchievements?: Array<{ id: string; name: string; icon: string }>;
						warnings?: string[];
					};
					if (
						data.newAchievements &&
						Array.isArray(data.newAchievements) &&
						data.newAchievements.length > 0
					) {
						// Dispatch custom event for UI to handle
						window.dispatchEvent(
							new CustomEvent('achievement-earned', {
								detail: { achievements: data.newAchievements },
							}),
						);
					}
					// Log warnings from server for debugging (stats tracking failures, etc.)
					if (data.warnings && Array.isArray(data.warnings) && data.warnings.length > 0) {
						console.warn('[BALANCE_SYNC] Server warnings:', data.warnings);
					}
					return;
				}

				const errorData = (await response.json().catch(() => ({}))) as {
					error?: string;
					message?: string;
					currentBalance?: number;
				};

				// Special handling for RATE_LIMITED: retry after delay instead of reverting
				if (errorData.error === 'RATE_LIMITED' && retryCount < 3) {
					const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10) * 1000;
					console.warn(
						`Chip update rate limited, retrying in ${retryAfter}ms (attempt ${retryCount + 1})`,
					);
					setStatusIfNotRoundResult('Syncing balance...');

					// Set syncPending to true only when first encountering rate limit
					// Stats are already added to pendingStats at the start of performChipUpdate
					syncPending = markSyncPendingOnRateLimit(syncPending);

					// Keep the current balance and retry after the rate limit window
					pendingRetryTimer = setTimeout(() => {
						performChipUpdate(retryCount + 1).catch((err) => {
							console.error('Retry failed:', err);
						});
					}, retryAfter + 100); // Add 100ms buffer
					return;
				}

				// For other errors, handle by reverting to server state
				if (errorData.currentBalance !== undefined) {
					// Server provided its current balance - use it as authoritative truth
					const serverBalance = errorData.currentBalance as number;
					serverSyncedBalance = serverBalance;
					game.setBalance(serverBalance);
					renderGame();
					setStatusIfNotRoundResult(`Balance synced to ${serverBalance} chips.`);
					// Clear pending stats since we're reverting to server state
					pendingStats = clearPendingStats();
					syncPending = false;
					statsIncluded = false;
					pendingRetryTimer = null;
				} else if (errorData.error !== 'RATE_LIMITED') {
					// Only revert for non-rate-limit errors when no server balance provided
					game.setBalance(serverSyncedBalance);
					renderGame();
					// Clear pending stats for non-rate-limit errors
					pendingStats = clearPendingStats();
					syncPending = false;
					statsIncluded = false;
					pendingRetryTimer = null;
				}

				// Show appropriate error message to user
				if (errorData.error === 'BALANCE_MISMATCH') {
					console.warn('Balance mismatch detected, synced to server balance');
					setStatusIfNotRoundResult('Balance corrected (server sync).');
				} else if (errorData.error === 'RATE_LIMITED') {
					// Max retries exceeded
					console.error('Chip update rate limited, max retries exceeded');
					setStatusIfNotRoundResult('Sync delayed. Balance will update on next round.');
				} else if (errorData.error === 'DELTA_EXCEEDS_LIMIT') {
					console.error('Delta exceeded server limit:', errorData.message);
					setStatusIfNotRoundResult('Payout exceeded limit. Please try a smaller bet.');
				} else {
					console.error('Chip update failed:', errorData.error, errorData.message);
					setStatusIfNotRoundResult('Balance sync failed. Will retry next round.');
				}
			};

			await performChipUpdate();
		} catch (error) {
			// Network error or other failure - revert to last synced balance
			console.error('Failed to update balance:', error);
			game.setBalance(serverSyncedBalance);
			renderGame();
			statusEl.textContent = 'Network error. Balance reverted.';
			// Clear pending stats on network errors
			pendingStats = clearPendingStats();
			syncPending = false;
			statsIncluded = false;
			pendingRetryTimer = null;
		}

		renderGame();
	}

	// Initial render
	renderGame();
}
