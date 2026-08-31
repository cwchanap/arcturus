import { BlackjackGame } from './BlackjackGame';
import { GameSettingsManager } from './GameSettingsManager';
import {
	getBlackjackAdvice,
	getBlackjackStrategyAdvice,
	type BlackjackAdviceContext,
} from './llmBlackjackStrategy';
import { getHandValueDisplay } from './handEvaluator';
import type { RoundOutcome, RoundResult } from './types';
import { renderCardsToContainer, clearCardsContainer, setSlotState } from '../card-slot-utils';
import { loadAiSettings, type AiSettings } from '../ai';
import { formatChipBalance, formatWholeNumber } from '../formatting';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { blackjackTranslator } from '../i18n/messages/blackjack';
import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';
import {
	createSettlementGate,
	ensureSettlementRecoveryControls,
	newSettlementId,
	type PublicGameSettlementMessages,
	type SettlementGate,
	type SettleRoundCommand,
	type SettleRoundResult,
} from '../wallet';

/** Build the one wallet command produced by a completed Blackjack round. */
export function buildBlackjackSettlementCommand(
	outcomes: readonly RoundOutcome[],
	delta: number,
	playerHands: readonly { bet: number }[],
): SettleRoundCommand {
	const wins = outcomes.filter(
		(outcome) => outcome.result === 'win' || outcome.result === 'blackjack',
	).length;
	const losses = outcomes.filter((outcome) => outcome.result === 'loss').length;
	const biggestWin = outcomes.reduce((largest, outcome) => {
		const bet = playerHands[outcome.handIndex]?.bet ?? 0;
		return Math.max(largest, outcome.payout - bet);
	}, 0);

	return {
		settlementId: newSettlementId('blackjack'),
		game: 'blackjack',
		delta,
		stats: {
			rounds: outcomes.length,
			wins,
			losses,
			biggestWin: Math.max(0, biggestWin),
		},
	};
}

/** Keep guest play local while blocking authenticated rounds behind the gate. */
export function canStartBlackjackRound({
	isGuestMode,
	gate,
}: {
	isGuestMode: boolean;
	gate: Pick<SettlementGate, 'isBlocked'>;
}): boolean {
	return isGuestMode || !gate.isBlocked;
}

/** Delegate recovery to the shared settlement gate. */
export function retryBlackjackSettlement(
	gate: Pick<SettlementGate, 'retry'>,
): Promise<SettleRoundResult | null> {
	return gate.retry();
}

/**
 * Format outcome message for display, handling split hands.
 * Shows individual results for each hand when split, or single result otherwise.
 * The outcome words are localized; the result is one complete sentence.
 */
export function formatBlackjackOutcomeMessage(
	outcomes: readonly RoundOutcome[],
	locale: Locale = 'en',
): string {
	const t = blackjackTranslator(locale);
	if (outcomes.length === 1) {
		// Single hand - use simple message
		switch (outcomes[0].result) {
			case 'blackjack':
				return t('outcomeBlackjack');
			case 'win':
				return t('outcomeWin');
			case 'loss':
				return t('outcomeLoss');
			case 'push':
				return t('outcomePush');
		}
	}

	// Multiple hands (split) - show each hand's result. The per-result
	// templates carry their own language-neutral marker.
	const resultText: Record<RoundResult, string> = {
		blackjack: t('splitBlackjack'),
		win: t('splitWin'),
		loss: t('splitLoss'),
		push: t('splitPush'),
	};

	const handResults = outcomes
		.map((o, i) =>
			t('splitHandResult', {
				number: formatWholeNumber(i + 1, locale),
				result: resultText[o.result],
			}),
		)
		.join(' | ');

	// Determine overall result based on wins vs losses
	const wins = outcomes.filter((o) => o.result === 'win' || o.result === 'blackjack').length;
	const losses = outcomes.filter((o) => o.result === 'loss').length;

	let summary = '';
	if (wins > losses) {
		summary = t('overallWin');
	} else if (losses > wins) {
		summary = t('overallLoss');
	} else {
		summary = t('overallSplit');
	}

	return t('splitSummary', { hands: handResults, summary });
}

/**
 * Initialize Blackjack client-side UI and game logic.
 * This function wires up DOM elements and game logic.
 */
export function initBlackjackClient(): void {
	// Initialize settings manager (per-user)
	const rootEl = document.getElementById('blackjack-root');
	const userId = rootEl?.getAttribute('data-user-id') ?? 'anonymous';
	const isGuestMode = isGuestModeValue(rootEl?.dataset?.guestMode);
	const locale = getDocumentLocale(rootEl?.ownerDocument);
	const t = blackjackTranslator(locale);
	const formatAmount = (value: number): string =>
		t('amount', { amount: formatChipBalance(value, locale) });
	const settingsManager = new GameSettingsManager(userId);
	let settings = settingsManager.getSettings();
	let dealerDelay = settingsManager.getDealerDelay();

	// Get initial balance from DOM; fall back to settings.startingChips if missing
	const balanceEl = document.getElementById('player-balance');
	const rawBalanceText = balanceEl?.textContent ?? `${settings.startingChips}`;
	const normalizedBalanceText = rawBalanceText.replace(/,/g, '');
	const balanceMatch = normalizedBalanceText.match(/-?\d+(?:\.\d+)?/);
	const parsedBalance = balanceMatch ? Number(balanceMatch[0]) : Number.NaN;
	// Number.isFinite() rejects NaN and +/-Infinity, which is sufficient here (we only want a real
	// numeric balance; anything else falls back to settings.startingChips).
	const initialBalance = Number.isFinite(parsedBalance) ? parsedBalance : settings.startingChips;

	const guestBankrollGameKey = 'blackjack';
	const restoredGuestBalance = isGuestMode
		? loadGuestBankroll(guestBankrollGameKey, userId, initialBalance)
		: initialBalance;

	// Persist the guest bankroll immediately after any balance mutation so a
	// mid-round refresh restores the current (post-wager) balance instead of the
	// pre-round balance. No-op for authenticated sessions (those sync to server).
	const persistGuestBalance = () => {
		if (isGuestMode) {
			persistGuestBankroll(guestBankrollGameKey, userId, game.getBalance());
		}
	};

	// Track the server-confirmed balance separately from game state. This is the
	// balance known by the wallet, updated only after successful settlements.
	let serverSyncedBalance = isGuestMode ? restoredGuestBalance : initialBalance;

	// Initialize game with configured bet limits
	const game = new BlackjackGame(serverSyncedBalance, settings.minBet, settings.maxBet);
	const settlementGate = createSettlementGate();

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

	// Recovery controls stay hidden during normal play and are revealed only when
	// a settlement fails. Keeping them out of the static page markup preserves
	// the existing game DOM until the user actually needs Retry/Reset.
	const settlementMessages: PublicGameSettlementMessages = {
		failed: t('settlementFailed'),
		retrying: t('retryingSettlement'),
		retryFailed: t('settlementRetryFailed'),
		retryLabel: t('retrySettlement'),
	};
	const settlementRecovery = ensureSettlementRecoveryControls({
		containerClass: 'hidden mt-3 flex flex-wrap justify-center gap-2',
		retryClass: 'deco-btn deco-btn-outline',
		retryLabel: settlementMessages.retryLabel,
		resetClass: 'deco-btn deco-btn-outline',
		resetLabel: t('resetRound'),
		attachTo: statusEl.parentElement,
	});

	const showSettlementRecovery = (message: string) => {
		statusEl.textContent = message;
		settlementRecovery.container?.classList.remove('hidden');
	};
	const hideSettlementRecovery = () => {
		settlementRecovery.container?.classList.add('hidden');
	};

	const adoptSettlementResult = (result: SettleRoundResult) => {
		serverSyncedBalance = result.balance;
		game.setBalance(result.balance);
		hideSettlementRecovery();
		if (result.newAchievements && result.newAchievements.length > 0) {
			window.dispatchEvent(
				new CustomEvent('achievement-earned', {
					detail: { achievements: result.newAchievements },
				}),
			);
		}
		renderGame();
	};

	const settleAuthenticatedRound = async (command: SettleRoundCommand): Promise<void> => {
		try {
			const result = await settlementGate.settle(command);
			adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Blackjack settlement failed:', error);
			showSettlementRecovery(settlementMessages.failed);
		}
	};

	settlementRecovery.retry?.addEventListener('click', async () => {
		if (!settlementGate.pending) return;
		statusEl.textContent = settlementMessages.retrying;
		try {
			const result = await retryBlackjackSettlement(settlementGate);
			if (result) adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Blackjack settlement retry failed:', error);
			showSettlementRecovery(settlementMessages.retryFailed);
		}
	});

	settlementRecovery.reset?.addEventListener('click', () => {
		settlementGate.reset();
		game.setBalance(serverSyncedBalance);
		hideSettlementRecovery();
		renderGame();
		statusEl.textContent = t('settlementReset');
	});

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
	const btnSaveSettings = document.getElementById('btn-save-settings') as HTMLButtonElement | null;
	const btnResetSettings = document.getElementById(
		'btn-reset-settings',
	) as HTMLButtonElement | null;

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
		if (!startingChipsInput || !minBetInput || !maxBetInput || !dealerSpeedSelect) return;
		startingChipsInput.value = settings.startingChips.toString();
		minBetInput.value = settings.minBet.toString();
		maxBetInput.value = settings.maxBet.toString();
		dealerSpeedSelect.value = settings.dealerSpeed;
	}

	// Settings panel toggle (only if elements exist)
	if (btnToggleSettings && settingsPanel) {
		btnToggleSettings.addEventListener('click', () => {
			settingsPanel.classList.toggle('hidden');
		});
	}

	// Save settings (only if elements exist)
	if (btnSaveSettings && startingChipsInput && minBetInput && maxBetInput && dealerSpeedSelect) {
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

			if (Number.isNaN(newStartingChips) || newStartingChips <= 0) {
				statusEl.textContent = t('settingsStartingChipsError');
				return;
			}

			if (
				Number.isNaN(newMinBet) ||
				Number.isNaN(newMaxBet) ||
				newMinBet <= 0 ||
				newMaxBet <= 0 ||
				newMinBet >= newMaxBet
			) {
				statusEl.textContent = t('settingsBetLimitsError');
				return;
			}

			settingsManager.updateSettings({
				startingChips: newStartingChips,
				minBet: newMinBet,
				maxBet: newMaxBet,
				dealerSpeed: newDealerSpeed,
			});

			const previousStartingChips = settings.startingChips;
			settings = settingsManager.getSettings();
			dealerDelay = settingsManager.getDealerDelay();

			// Update game instance bet limits so new rounds honor configured limits immediately
			game.updateBetLimits(settings.minBet, settings.maxBet);

			// Starting chips is a *settings* value. For authenticated users, chip balance is
			// server-authoritative (to avoid rate-limit / optimistic-lock flakiness), so we do not
			// attempt to sync or overwrite the user's real balance here.
			// For guest sessions, apply it immediately to the in-memory game balance.
			if (isGuestMode && newStartingChips !== previousStartingChips) {
				const balanceUpdated = game.setBalance(newStartingChips);
				if (balanceUpdated) {
					serverSyncedBalance = newStartingChips;
					persistGuestBankroll(guestBankrollGameKey, userId, newStartingChips);
					renderGame();
				}
			}

			applyBetConstraints();
			renderSettingsForm();
			statusEl.textContent = t('settingsSaved');
		});
	}

	// Reset settings (only if elements exist)
	if (btnResetSettings) {
		btnResetSettings.addEventListener('click', () => {
			settingsManager.resetToDefaults();
			settings = settingsManager.getSettings();
			dealerDelay = settingsManager.getDealerDelay();

			// Update game instance bet limits so new rounds honor reset limits immediately
			game.updateBetLimits(settings.minBet, settings.maxBet);

			applyBetConstraints();
			renderSettingsForm();

			statusEl.textContent = t('settingsReset');
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
			statusEl.textContent = t('betRangeError', {
				min: formatAmount(settings.minBet),
				max: formatAmount(settings.maxBet),
			});
			return;
		}

		if (betAmount > game.getBalance()) {
			statusEl.textContent = t('insufficientBalance');
			return;
		}

		try {
			game.placeBet(betAmount);
			game.deal();
			persistGuestBalance();

			// Update UI
			renderGame();
			bettingControls.classList.add('hidden');
			gameControls.classList.remove('hidden');
			statusEl.textContent = t('yourTurn', { hit: t('hit'), stand: t('stand') });

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
				statusEl.textContent = t('playingHand', {
					current: formatWholeNumber(stateAfter.activeHandIndex + 1, locale),
					total: formatWholeNumber(stateAfter.playerHands.length, locale),
				});
				renderGame();
			} else {
				// All hands complete, play dealer turn
				statusEl.textContent = t('dealerPlaying');
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
			persistGuestBalance();
			const stateAfter = game.getState();

			// Check what phase we're in after double down
			if (stateAfter.phase === 'player-turn') {
				// Still in player turn means there's another split hand to play
				statusEl.textContent = t('playingHand', {
					current: formatWholeNumber(stateAfter.activeHandIndex + 1, locale),
					total: formatWholeNumber(stateAfter.playerHands.length, locale),
				});
				renderGame();
			} else if (stateAfter.phase === 'complete') {
				// Busted on last hand - go straight to round complete
				renderGame();
				setTimeout(() => {
					void handleRoundComplete();
				}, dealerDelay);
			} else {
				// Dealer turn - play dealer
				statusEl.textContent = t('dealerPlaying');
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
			persistGuestBalance();
			statusEl.textContent = t('playingHandOne');
			renderGame();
		} catch (error) {
			statusEl.textContent = (error as Error).message;
		}
	});

	// New round button
	btnNewRound.addEventListener('click', () => {
		if (!canStartBlackjackRound({ isGuestMode, gate: settlementGate })) {
			showSettlementRecovery(t('settlementPending'));
			return;
		}

		game.startNewRound();
		renderGame();
		bettingControls.classList.remove('hidden');
		gameControls.classList.add('hidden');
		btnNewRound.classList.add('hidden');
		aiAdviceBox.classList.add('hidden');

		// Reset card placeholders
		const singleHandContainer = document.getElementById('player-cards-single');
		const splitHandsContainer = document.getElementById('player-cards-split');
		singleHandContainer?.classList.remove('hidden');
		splitHandsContainer?.classList.add('hidden');
		splitHandsContainer?.classList.remove('flex');

		clearCardsContainer('player-cards', 2);
		clearCardsContainer('dealer-cards', 2);

		statusEl.textContent = t('placeBet');
	});

	// AI Rival button
	btnAiRival.addEventListener('click', async () => {
		const state = game.getState();

		// Check if we're in player turn
		if (state.phase !== 'player-turn') {
			return;
		}

		const activeHandIndex = state.activeHandIndex;
		const activeHand = state.playerHands[activeHandIndex];
		const dealerUpCard = state.dealerHand.cards[0];

		const context: BlackjackAdviceContext = {
			playerHand: activeHand,
			dealerUpCard: dealerUpCard,
			availableActions: game.getAvailableActions(),
			playerBalance: game.getBalance(),
			currentBet: activeHand.bet,
		};

		// 1. Render the deterministic recommendation synchronously so the user
		//    never waits on the provider for an answer that is already known.
		const deterministic = getBlackjackStrategyAdvice(context, locale);
		aiAdviceBox.classList.remove('hidden');
		aiAdviceAction.textContent = deterministic.recommendedAction
			? t('aiRecommended', { action: localizedActionName(deterministic.recommendedAction) })
			: t('noLegalRecommendation');
		aiAdviceReasoning.textContent = deterministic.reasoning;
		highlightRecommendedAction(deterministic.recommendedAction);

		// 2. Optionally ask the provider to rewrite only the reasoning. The
		//    recommended action is never changed by the provider.
		const providerSettings: AiSettings | null = isGuestMode ? null : loadAiSettings();
		if (!providerSettings || !deterministic.recommendedAction) return;

		// Capture the turn identity so a late provider response cannot update
		// advice after the hand has advanced.
		const turnSignature = `${activeHandIndex}:${activeHand.cards
			.map((card) => `${card.rank}${card.suit}`)
			.join(',')}`;

		btnAiRival.disabled = true;
		btnAiRivalText.textContent = t('aiThinking');
		try {
			const advice = await getBlackjackAdvice(context, providerSettings, locale);
			const current = game.getState();
			const currentHand = current.playerHands[current.activeHandIndex];
			const currentSignature = `${current.activeHandIndex}:${currentHand?.cards
				.map((card) => `${card.rank}${card.suit}`)
				.join(',')}`;
			if (current.phase === 'player-turn' && currentSignature === turnSignature) {
				aiAdviceReasoning.textContent = advice.reasoning;
			}
		} catch (_error) {
			// Deterministic advice is already shown; leave it in place.
		} finally {
			btnAiRival.disabled = false;
			btnAiRivalText.textContent = t('askAiRival');
		}
	});

	// Highlight recommended action button
	function highlightRecommendedAction(action: string | null) {
		// Remove existing highlights
		[btnHit, btnStand, btnDouble, btnSplit].forEach((btn) => {
			btn.classList.remove('ring-2', 'ring-offset-2', 'ring-[var(--deco-brass-bright)]');
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
			targetBtn.classList.add('ring-2', 'ring-offset-2', 'ring-[var(--deco-brass-bright)]');
		}
	}

	// Localized action name for advice copy (action keys are language-neutral).
	const localizedActionName = (action: string): string => {
		switch (action) {
			case 'hit':
				return t('hit');
			case 'stand':
				return t('stand');
			case 'double-down':
				return t('doubleDown');
			case 'split':
				return t('split');
			default:
				return action;
		}
	};

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
						if (labelEl) {
							labelEl.textContent = t('handLabel', {
								number: formatWholeNumber(index + 1, locale),
							});
						}

						// Update hand value
						const valueEl = container.querySelector('[data-hand-value]');
						if (valueEl) valueEl.textContent = getHandValueDisplay(hand.cards);

						// Update hand bet
						const betEl = container.querySelector('[data-hand-bet]');
						if (betEl) betEl.textContent = formatAmount(hand.bet);

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
				currentBetEl.textContent = t('handBet', {
					number: formatWholeNumber(state.activeHandIndex + 1, locale),
					amount: formatAmount(activeHand.bet),
				});
			} else {
				// Single hand - show single container, hide split
				singleHandContainer?.classList.remove('hidden');
				splitHandsContainer?.classList.add('hidden');
				splitHandsContainer?.classList.remove('flex');

				const playerHand = state.playerHands[0];
				renderCardsToContainer('player-cards', playerHand.cards, { showPlaceholders: 2 });
				playerValueEl.textContent = getHandValueDisplay(playerHand.cards);
				currentBetEl.textContent = t('currentBet', { amount: formatAmount(playerHand.bet) });
			}
		} else {
			// Show placeholders when no cards dealt
			singleHandContainer?.classList.remove('hidden');
			splitHandsContainer?.classList.add('hidden');
			splitHandsContainer?.classList.remove('flex');
			clearCardsContainer('player-cards', 2);
			playerValueEl.textContent = '-';
			currentBetEl.textContent = t('currentBet', { amount: formatAmount(0) });
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
		balanceDisplay.textContent = formatAmount(game.getBalance());

		// Update button states with dynamic tooltips
		const actions = game.getAvailableActions();
		const actionInfo = game.getActionAvailability();

		btnHit.disabled = !actions.includes('hit');
		btnStand.disabled = !actions.includes('stand');

		// Double-down button with explanatory tooltip
		btnDouble.disabled = !actions.includes('double-down');
		if (actionInfo.doubleDown.available) {
			btnDouble.title = t('doubleTip');
		} else if (actionInfo.doubleDown.reason) {
			btnDouble.title = actionInfo.doubleDown.reason;
		}

		// Split button with explanatory tooltip
		btnSplit.disabled = !actions.includes('split');
		if (actionInfo.split.available) {
			btnSplit.title = t('splitTip');
		} else if (actionInfo.split.reason) {
			btnSplit.title = actionInfo.split.reason;
		}
	}

	// Handle round completion
	async function handleRoundComplete() {
		// Capture state before settleRound() clears the hands for settlement stats.
		const state = game.getState();
		const outcomes = game.settleRound();

		// Aggregate outcomes for split hands
		const message = formatBlackjackOutcomeMessage(outcomes, locale);
		statusEl.textContent = message;

		// Hide advice box and clear highlights
		aiAdviceBox.classList.add('hidden');
		highlightRecommendedAction(null);

		// Show new round button immediately so UI/tests can detect completion.
		// Balance sync can continue asynchronously.
		btnNewRound.classList.remove('hidden');

		let settlementPromise: Promise<void> | null = null;
		if (shouldSyncAccountChips({ isGuestMode })) {
			const command = buildBlackjackSettlementCommand(
				outcomes,
				game.getBalance() - serverSyncedBalance,
				state.playerHands,
			);
			// Start the gate before settlement, so New Round observes the blocked
			// state throughout the settlement attempt.
			settlementPromise = settleAuthenticatedRound(command);
		}

		if (!shouldSyncAccountChips({ isGuestMode })) {
			if (isGuestMode) {
				persistGuestBankroll(guestBankrollGameKey, userId, game.getBalance());
			}
			renderGame();
			return;
		}

		await settlementPromise;
	}

	// Initial render
	renderGame();
}
