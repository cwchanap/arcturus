import { BlackjackGame } from './BlackjackGame';
import { GameSettingsManager } from './GameSettingsManager';
import {
	getBlackjackAdvice,
	getRoundCommentary,
	type LLMSettings,
	type BlackjackAdviceContext,
} from './llmBlackjackStrategy';

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

	// Settings panel elements
	const btnToggleSettings = document.getElementById('btn-toggle-settings') as HTMLButtonElement;
	const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
	const startingChipsInput = document.getElementById('setting-starting-chips') as HTMLInputElement;
	const minBetInput = document.getElementById('setting-min-bet') as HTMLInputElement;
	const maxBetInput = document.getElementById('setting-max-bet') as HTMLInputElement;
	const dealerSpeedSelect = document.getElementById(
		'setting-dealer-speed',
	) as unknown as HTMLSelectElement;
	const useLlmCheckbox = document.getElementById('setting-use-llm') as HTMLInputElement;
	const btnSaveSettings = document.getElementById('btn-save-settings') as HTMLButtonElement;
	const btnResetSettings = document.getElementById('btn-reset-settings') as HTMLButtonElement;

	// Load LLM settings on page load
	async function loadLlmSettings() {
		try {
			const response = await fetch('/api/profile/llm-settings');
			if (!response.ok) {
				llmSettings = null;
				llmConfigured = false;
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
		startingChipsInput.value = settings.startingChips.toString();
		minBetInput.value = settings.minBet.toString();
		maxBetInput.value = settings.maxBet.toString();
		dealerSpeedSelect.value = settings.dealerSpeed;
		useLlmCheckbox.checked = settings.useLLM;
	}

	// Settings panel toggle
	btnToggleSettings.addEventListener('click', () => {
		settingsPanel.classList.toggle('hidden');
	});

	// Save settings
	btnSaveSettings.addEventListener('click', () => {
		const newStartingChips = parseInt(startingChipsInput.value || `${settings.startingChips}`, 10);
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

		settings = settingsManager.getSettings();
		dealerDelay = settingsManager.getDealerDelay();
		llmUserEnabled = settings.useLLM;

		applyBetConstraints();
		renderSettingsForm();

		statusEl.textContent = 'Settings saved. They will apply to new rounds.';
	});

	// Reset settings
	btnResetSettings.addEventListener('click', () => {
		settingsManager.resetToDefaults();
		settings = settingsManager.getSettings();
		dealerDelay = settingsManager.getDealerDelay();
		llmUserEnabled = settings.useLLM;

		applyBetConstraints();
		renderSettingsForm();

		statusEl.textContent = 'Settings reset to defaults.';
	});

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
			const state = game.getState();
			// Check if there are more hands to play (after split)
			if (state.playerHands.length > 1 && state.activeHandIndex < state.playerHands.length - 1) {
				game.stand();
				game.nextHand();
				statusEl.textContent = `Playing hand ${state.activeHandIndex + 2}...`;
				renderGame();
			} else {
				// All hands complete, play dealer turn
				game.stand();
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
						const borderClass = isActive ? 'border-2 border-yellow-400' : 'border border-slate-600';
						const cardsHTML = hand.cards
							.map(
								(card) =>
									`<div class="card" data-suit="${card.suit}">${card.rank}${getSuitSymbol(card.suit)}</div>`,
							)
							.join('');
						return `
							<div class="flex flex-col items-center gap-2 p-3 rounded-lg ${borderClass}">
								<div class="text-xs text-slate-400">Hand ${index + 1}</div>
								<div class="flex gap-2">${cardsHTML}</div>
								<div class="text-sm font-bold">${getHandDisplay(hand.cards)}</div>
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
				playerCardsEl.innerHTML = playerHand.cards
					.map(
						(card) =>
							`<div class="card" data-suit="${card.suit}">${card.rank}${getSuitSymbol(card.suit)}</div>`,
					)
					.join('');
				playerValueEl.textContent = getHandDisplay(playerHand.cards);
				currentBetEl.textContent = `Bet: $${playerHand.bet}`;
			}
		}

		// Render dealer hand
		const dealerCardsEl = document.getElementById('dealer-cards');
		const dealerValueEl = document.getElementById('dealer-value');
		if (!dealerCardsEl || !dealerValueEl) return;

		const hideCard = state.phase === 'player-turn' || state.phase === 'dealing';

		if (state.dealerHand.cards.length > 0) {
			const visibleCards = hideCard ? [state.dealerHand.cards[0]] : state.dealerHand.cards;

			dealerCardsEl.innerHTML =
				visibleCards
					.map(
						(card) =>
							`<div class="card" data-suit="${card.suit}">${card.rank}${getSuitSymbol(card.suit)}</div>`,
					)
					.join('') + (hideCard ? '<div class="card card-hidden">🂠</div>' : '');

			dealerValueEl.textContent = hideCard
				? '?'
				: getHandDisplay(state.dealerHand.cards as { rank: string; suit: string }[]);
		} else {
			dealerCardsEl.innerHTML = '';
			dealerValueEl.textContent = '-';
		}

		// Update balance
		balanceDisplay.textContent = `$${game.getBalance()}`;

		// Update button states
		const actions = game.getAvailableActions();
		btnHit.disabled = !actions.includes('hit');
		btnStand.disabled = !actions.includes('stand');
		btnDouble.disabled = !actions.includes('double-down');
		btnSplit.disabled = !actions.includes('split');
	}

	// Handle round completion
	async function handleRoundComplete() {
		const state = game.getState();
		const outcomes = game.settleRound();
		const outcome = outcomes[0];

		// Display result
		let message = '';
		switch (outcome.result) {
			case 'blackjack':
				message = '🎉 BLACKJACK! You win!';
				break;
			case 'win':
				message = '✓ You win!';
				break;
			case 'loss':
				message = '✗ Dealer wins';
				break;
			case 'push':
				message = '🤝 Push (Tie)';
				break;
		}
		statusEl.textContent = message;

		// Hide advice box and clear highlights
		aiAdviceBox.classList.add('hidden');
		highlightRecommendedAction(null);

		// Get AI commentary if configured
		if (llmConfigured && llmSettings) {
			try {
				const playerHand = state.playerHands[0];
				const dealerHand = state.dealerHand;
				const commentary = await getRoundCommentary(
					playerHand,
					dealerHand,
					outcome.result,
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
			await fetch('/api/chips/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					newBalance: game.getBalance(),
					delta: outcome.payout - outcome.handIndex, // Simplified
					gameType: 'blackjack',
				}),
			});
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

	function getHandDisplay(cards: { rank: string; suit: string }[]): string {
		let total = 0;
		let aces = 0;

		for (const card of cards) {
			if (card.rank === 'A') {
				aces++;
				total += 11;
			} else if (['K', 'Q', 'J'].includes(card.rank)) {
				total += 10;
			} else {
				total += parseInt(card.rank, 10);
			}
		}

		while (total > 21 && aces > 0) {
			total -= 10;
			aces--;
		}

		if (total > 21) return 'Bust';
		if (aces > 0 && total <= 21) return `Soft ${total}`;
		return total.toString();
	}

	// Initial render
	renderGame();
}
