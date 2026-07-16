/**
 * PokerGame class - Main game controller for Texas Hold'em
 * Refactored to use specialized helper classes
 */

import type { Card, Player, BettingRound, GameContext, GameSettings } from './types';
import type { AIConfig, AIPersonality, AIDifficulty, TierResult } from './index';
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
	resolveSidePotAwards,
	determineShowdownWinners,
	createAIConfig,
	isAIDifficulty,
	makeAIDecision,
} from './index';
import { DeckManager } from './DeckManager';
import { PokerUIRenderer } from './PokerUIRenderer';
import { AIRivalAssistant } from './AIRivalAssistant';
import { GameSettingsManager, isAIPersonality, isAISpeed } from './GameSettingsManager';
import { makeLLMDecision, clearLLMCache } from './llmAIStrategy';
import {
	DEFAULT_GUEST_GAME_BALANCE,
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';

type ChipSyncOutcome = 'win' | 'loss' | 'push';
const VALID_CHIP_SYNC_OUTCOMES = new Set<string>(['win', 'loss', 'push']);
const CHIP_SYNC_RETRY_DELAY_MS = 2000;
const PENDING_SYNCS_STORAGE_KEY_PREFIX = 'arcturus_poker_pending_syncs';
const MAX_DEAL_SYNC_RETRIES = 10;
// Client-side TTL for persisted pending chip syncs. Must be shorter than the
// server-side retention window (RETENTION_DAYS = 30 in src/server/cleanup.ts)
// so that a stale snapshot is dropped before its idempotency receipt row is
// deleted. Without this, a sync that committed server-side but whose response
// was lost could be replayed after cleanup as a fresh update, double-applying
// the delta.
const PENDING_SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type PendingChipSync = {
	syncId: string;
	previousBalance: number;
	delta: number;
	outcome?: ChipSyncOutcome;
	biggestWinCandidate?: number;
	createdAt: number;
};

type EarnedAchievement = {
	id: string;
	name: string;
	icon: string;
};

type AIDifficultySetting = GameSettings['aiDifficulty1'];

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
	private aiRandom?: () => number;
	private pendingChipReset = false; // Flag to reset chips on next deal
	private hasServerSyncedBalance = false;
	private serverSyncedBalance: number = 0; // Last confirmed server chip balance
	private humanChipsBefore: number = 0; // Human chip count at start of current hand (before blinds)
	private pendingChipSyncs: PendingChipSync[] = [];
	private isChipSyncInFlight = false;
	private pendingSyncsDirty = false;
	private pendingSyncsStorageKey: string;
	private autoDealTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private autoDealToken = 0;
	private chipSyncRetryTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
	private turnTransitionTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private pendingTurnTransitionResolver: ((completed: boolean) => void) | null = null;
	private turnTransitionToken = 0;
	private dealSyncRetryCount = 0;
	private isGuestMode = false;
	private clientUserId = '';
	private static readonly GUEST_BANKROLL_GAME_KEY = 'poker';

	constructor(aiRandom?: () => number) {
		this.aiRandom = aiRandom;
		this.deck = new DeckManager();
		this.ui = new PokerUIRenderer();
		this.aiRival = new AIRivalAssistant();
		this.settingsManager = new GameSettingsManager();

		// Seed serverSyncedBalance from the server-rendered DOM value
		const balanceEl = document.getElementById('player-balance');
		const rootEl = document.getElementById('poker-root');
		this.isGuestMode =
			isGuestModeValue(balanceEl?.dataset?.guestMode) ||
			isGuestModeValue(rootEl?.dataset?.guestMode);
		const balanceAvailable = balanceEl?.dataset?.balanceAvailable;
		const rawBalance = balanceEl?.dataset?.balance ?? balanceEl?.textContent ?? '';
		// Strip locale formatting (commas, currency symbols) then parse
		const sanitized = rawBalance.replace(/[^0-9.-]/g, '');
		const hasDigit = /[0-9]/.test(sanitized);
		const parsed = hasDigit ? Number(sanitized) : Number.NaN;
		this.hasServerSyncedBalance =
			this.isGuestMode || (balanceAvailable === 'false' ? false : Number.isFinite(parsed));
		this.serverSyncedBalance = this.hasServerSyncedBalance ? Math.trunc(parsed) : 0;

		const userId = balanceEl?.dataset?.userId ?? '';
		this.clientUserId = userId;
		this.pendingSyncsStorageKey = userId
			? `${PENDING_SYNCS_STORAGE_KEY_PREFIX}:${userId}`
			: PENDING_SYNCS_STORAGE_KEY_PREFIX;

		if (this.isGuestMode && this.hasServerSyncedBalance) {
			this.serverSyncedBalance = loadGuestBankroll(
				PokerGame.GUEST_BANKROLL_GAME_KEY,
				userId,
				this.serverSyncedBalance,
			);
		}

		this.initPlayers();
		// Guests restore their bankroll from localStorage, which may differ from
		// the server-rendered #player-balance (default $1,000). Sync the DOM to
		// the restored stack now so it doesn't disagree with the bet slider until
		// the first action triggers updateUI.
		if (this.isGuestMode && this.hasServerSyncedBalance) {
			this.ui.updateUI(this.pot, this.players[0]);
		}
		this.attachEventListeners();
		this.attachSettingsListeners();
		this.renderSettingsPanel();
		this.updateBetControls(); // Initialize bet controls based on settings
		this.aiRival.highlightSuggestedMove(null);

		if (!this.hasServerSyncedBalance) {
			const dealButton = document.getElementById('btn-deal') as HTMLButtonElement | null;
			if (dealButton) {
				dealButton.disabled = true;
			}
			this.updateGameStatus('Unable to load your chip balance. Refresh the page to try again.');
		} else if (!this.isGuestMode) {
			this.loadPersistedPendingSyncs();
			if (this.pendingChipSyncs.length > 0) {
				this.rebaseHumanTableBalance(this.serverSyncedBalance);
				void this.flushChipSyncQueue();
			}
		}

		// On load, if LLM AI is enabled but no key is configured, show overlay immediately
		void this.checkLlmConfigOnLoad();

		window.addEventListener('beforeunload', () => {
			this.finalizeActiveHandBeforeDeal();
			if (!this.isGuestMode) {
				this.persistPendingSyncs();
			}
		});
	}

	private getPendingChipSyncDelta(): number {
		return this.pendingChipSyncs.reduce((sum, sync) => sum + sync.delta, 0);
	}

	private getEffectiveServerBalance(): number {
		return Math.max(0, this.serverSyncedBalance + this.getPendingChipSyncDelta());
	}

	private createChipSyncId(): string {
		if (typeof globalThis.crypto?.randomUUID === 'function') {
			return globalThis.crypto.randomUUID();
		}

		return `poker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}

	private rebasePendingChipSyncBaselines(serverBalance: number): void {
		if (this.pendingChipSyncs.length === 0) {
			return;
		}

		const baselineShift = serverBalance - this.pendingChipSyncs[0].previousBalance;
		if (baselineShift === 0) {
			return;
		}

		this.pendingChipSyncs = this.pendingChipSyncs.map((pendingSync) => ({
			...pendingSync,
			previousBalance: Math.max(0, pendingSync.previousBalance + baselineShift),
		}));
		this.markPendingSyncsDirty();
	}

	private rebaseHumanTableBalance(serverBalance: number): void {
		const pendingDelta = this.getPendingChipSyncDelta();
		const currentHandDelta =
			this.humanChipsBefore > 0 ? this.players[0].chips - this.humanChipsBefore : 0;
		const rebasedBaseline = Math.max(0, serverBalance + pendingDelta);

		this.serverSyncedBalance = serverBalance;

		if (this.humanChipsBefore > 0) {
			this.humanChipsBefore = rebasedBaseline;
			this.players[0] = {
				...this.players[0],
				chips: Math.max(0, rebasedBaseline + currentHandDelta),
			};
		} else {
			this.players[0] = {
				...this.players[0],
				chips: rebasedBaseline,
			};
		}

		this.ui.updateUI(this.pot, this.players[0]);
		this.updateActionButtons();
	}

	private acknowledgeAppliedChipSync(sync: PendingChipSync, serverBalance: number): void {
		const remainingPendingDelta = this.pendingChipSyncs
			.slice(1)
			.reduce((sum, pendingSync) => sum + pendingSync.delta, 0);
		const currentHandDelta =
			this.humanChipsBefore > 0 ? this.players[0].chips - this.humanChipsBefore : 0;
		const rebasedBaseline = Math.max(0, serverBalance + remainingPendingDelta);

		this.serverSyncedBalance = serverBalance;

		if (this.humanChipsBefore > 0) {
			this.humanChipsBefore = rebasedBaseline;
			this.players[0] = {
				...this.players[0],
				chips: Math.max(0, rebasedBaseline + currentHandDelta),
			};
		} else {
			this.players[0] = {
				...this.players[0],
				chips: rebasedBaseline,
			};
		}

		this.ui.updateUI(this.pot, this.players[0]);
		this.updateActionButtons();
	}

	private dispatchEarnedAchievements(achievements?: EarnedAchievement[]): void {
		if (!achievements || achievements.length === 0) {
			return;
		}

		if (
			typeof window === 'undefined' ||
			typeof window.dispatchEvent !== 'function' ||
			typeof CustomEvent !== 'function'
		) {
			return;
		}

		window.dispatchEvent(
			new CustomEvent('achievement-earned', {
				detail: { achievements },
			}),
		);
	}

	private discardRejectedChipSync(sync: PendingChipSync): void {
		this.rebasePendingChipSyncBaselines(sync.previousBalance);
		this.rebaseHumanTableBalance(sync.previousBalance);
		this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
	}

	private clearTimeoutRef(id: ReturnType<typeof setTimeout> | null): null {
		if (id !== null) {
			clearTimeout(id);
		}
		return null;
	}

	private cancelPendingAutoDeal(): void {
		this.autoDealToken += 1;
		this.autoDealTimeoutId = this.clearTimeoutRef(this.autoDealTimeoutId);
	}

	private cancelPendingChipSyncRetry(): void {
		this.chipSyncRetryTimeoutId = this.clearTimeoutRef(this.chipSyncRetryTimeoutId);
	}

	private clearPendingTurnTransitionTimeout(completed: boolean): void {
		this.turnTransitionTimeoutId = this.clearTimeoutRef(this.turnTransitionTimeoutId);

		if (this.pendingTurnTransitionResolver !== null) {
			const resolvePendingTurnTransition = this.pendingTurnTransitionResolver;
			this.pendingTurnTransitionResolver = null;
			resolvePendingTurnTransition(completed);
		}
	}

	private cancelPendingTurnTransitions(): void {
		this.turnTransitionToken += 1;
		this.clearPendingTurnTransitionTimeout(false);
		this.isProcessingAction = false;
	}

	private scheduleTurnTransition(delayMs: number, callback: () => void): void {
		const turnTransitionToken = this.turnTransitionToken;
		this.clearPendingTurnTransitionTimeout(false);
		this.turnTransitionTimeoutId = setTimeout(() => {
			this.turnTransitionTimeoutId = null;
			if (turnTransitionToken !== this.turnTransitionToken) {
				return;
			}
			callback();
		}, delayMs);
	}

	private waitForTurnTransition(delayMs: number, turnTransitionToken: number): Promise<boolean> {
		this.clearPendingTurnTransitionTimeout(false);
		return new Promise((resolve) => {
			this.pendingTurnTransitionResolver = resolve;
			this.turnTransitionTimeoutId = setTimeout(() => {
				this.turnTransitionTimeoutId = null;
				this.pendingTurnTransitionResolver = null;
				resolve(turnTransitionToken === this.turnTransitionToken);
			}, delayMs);
		});
	}

	private persistPendingSyncs(): void {
		if (this.pendingSyncsDirty) {
			this.pendingSyncsDirty = false;
		}
		try {
			if (this.pendingChipSyncs.length === 0) {
				localStorage.removeItem(this.pendingSyncsStorageKey);
			} else {
				localStorage.setItem(this.pendingSyncsStorageKey, JSON.stringify(this.pendingChipSyncs));
			}
		} catch {
			// localStorage unavailable or full — best effort
		}
	}

	private loadPersistedPendingSyncs(): void {
		try {
			const raw = localStorage.getItem(this.pendingSyncsStorageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed) || parsed.length === 0) return;
			const SYNC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
			const now = Date.now();
			const restored: PendingChipSync[] = [];
			for (const entry of parsed) {
				if (
					typeof entry?.syncId === 'string' &&
					SYNC_ID_RE.test(entry.syncId) &&
					typeof entry.previousBalance === 'number' &&
					Number.isInteger(entry.previousBalance) &&
					typeof entry.delta === 'number' &&
					Number.isInteger(entry.delta)
				) {
					// Drop legacy entries written before the TTL fix: a missing
					// createdAt gives no bound on how long the entry has sat in
					// localStorage. If the server already committed it (response
					// lost / client crashed before clearing storage) more than
					// RETENTION_DAYS ago, runRetentionCleanup will have reaped
					// the idempotency receipt, so replaying the same syncId
					// would re-apply the delta (double-spend). We cannot
					// distinguish "never committed" from "committed long ago"
					// without a timestamp, and creating chips out of thin air
					// is a worse failure than losing a stale pending win, so
					// legacy entries are discarded rather than replayed.
					const createdAt = entry.createdAt;
					if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
						continue;
					}
					if (now - createdAt > PENDING_SYNC_MAX_AGE_MS) {
						continue;
					}
					const restoredEntry: PendingChipSync = {
						syncId: entry.syncId,
						previousBalance: entry.previousBalance,
						delta: entry.delta,
						createdAt,
					};
					if (typeof entry.outcome === 'string' && VALID_CHIP_SYNC_OUTCOMES.has(entry.outcome)) {
						restoredEntry.outcome = entry.outcome as ChipSyncOutcome;
						if (
							typeof entry.biggestWinCandidate === 'number' &&
							Number.isInteger(entry.biggestWinCandidate) &&
							entry.biggestWinCandidate >= 0
						) {
							restoredEntry.biggestWinCandidate = entry.biggestWinCandidate;
						}
					}
					restored.push(restoredEntry);
				}
			}
			if (restored.length > 0) {
				this.pendingChipSyncs = restored;
			} else {
				// All entries were stale/invalid — clear the orphaned storage.
				localStorage.removeItem(this.pendingSyncsStorageKey);
			}
		} catch {
			// Corrupted data — ignore
		}
	}

	private markPendingSyncsDirty(): void {
		this.pendingSyncsDirty = true;
		try {
			queueMicrotask(() => {
				if (this.pendingSyncsDirty) {
					this.persistPendingSyncs();
				}
			});
		} catch {
			this.persistPendingSyncs();
		}
	}

	private scheduleChipSyncRetry(delayMs = CHIP_SYNC_RETRY_DELAY_MS): void {
		if (this.pendingChipSyncs.length === 0 || this.isChipSyncInFlight) {
			return;
		}

		this.cancelPendingChipSyncRetry();
		this.chipSyncRetryTimeoutId = setTimeout(() => {
			this.chipSyncRetryTimeoutId = null;
			void this.flushChipSyncQueue();
		}, delayMs);
	}

	private getChipSyncRetryDelayMs(retryAfterHeader?: string | null): number {
		const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '', 10);
		if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
			return retryAfterSeconds * 1000;
		}

		return CHIP_SYNC_RETRY_DELAY_MS;
	}

	private scheduleAutoDeal(delayMs: number): void {
		this.cancelPendingAutoDeal();
		const autoDealToken = this.autoDealToken;
		this.autoDealTimeoutId = setTimeout(() => {
			if (autoDealToken !== this.autoDealToken) {
				return;
			}
			this.autoDealTimeoutId = null;
			void this.dealNewHand();
		}, delayMs);
	}

	private getBiggestWinCandidate(delta: number): number {
		return Math.max(0, delta);
	}

	/**
	 * Check LLM configuration once on page load.
	 * If LLM AI is enabled but no valid key is configured, show the overlay and
	 * prevent the user from starting LLM-powered games until resolved.
	 */
	private async checkLlmConfigOnLoad() {
		if (this.isGuestMode) {
			return;
		}

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

	private syncChips(outcome?: ChipSyncOutcome): void {
		if (!shouldSyncAccountChips({ isGuestMode: this.isGuestMode })) {
			if (this.isGuestMode) {
				// Persist the new chip count and keep the in-memory baseline in
				// step with it. Without this, dealNewHand() would use the stale
				// page-load baseline via getEffectiveServerBalance() and silently
				// revive a busted guest instead of routing to game-over/rebuy;
				// saving settings would also reset them to the stale amount.
				const persistedChips = Math.max(0, this.players[0]?.chips ?? this.serverSyncedBalance);
				persistGuestBankroll(PokerGame.GUEST_BANKROLL_GAME_KEY, this.clientUserId, persistedChips);
				this.serverSyncedBalance = persistedChips;
			}
			this.humanChipsBefore = 0;
			return;
		}

		if (!this.hasServerSyncedBalance) {
			console.warn('[CHIP_SYNC] syncChips called without an available server balance; skipping.');
			return;
		}

		if (this.humanChipsBefore <= 0) {
			console.warn('[CHIP_SYNC] syncChips called before hand baseline established; skipping.');
			return;
		}

		const delta = this.players[0].chips - this.humanChipsBefore;
		const pendingSync: PendingChipSync = {
			syncId: this.createChipSyncId(),
			previousBalance: this.getEffectiveServerBalance(),
			delta,
			createdAt: Date.now(),
		};
		if (outcome !== undefined) {
			pendingSync.outcome = outcome;
			pendingSync.biggestWinCandidate =
				outcome === 'win' && delta > 0 ? this.getBiggestWinCandidate(delta) : 0;
		}
		this.pendingChipSyncs.push(pendingSync);
		this.markPendingSyncsDirty();
		this.humanChipsBefore = 0;
		if (this.chipSyncRetryTimeoutId !== null) {
			return;
		}
		void this.flushChipSyncQueue();
	}

	private finalizeActiveHandBeforeDeal(): void {
		if (this.humanChipsBefore <= 0) {
			return;
		}

		this.syncChips('loss');
	}

	private async flushChipSyncQueue(): Promise<void> {
		if (this.pendingChipSyncs.length === 0) {
			this.cancelPendingChipSyncRetry();
			return;
		}

		if (this.isChipSyncInFlight) {
			return;
		}

		this.cancelPendingChipSyncRetry();
		this.isChipSyncInFlight = true;

		try {
			let retryCount = 0;
			const MAX_RETRIES = 3;

			while (this.pendingChipSyncs.length > 0) {
				// Enforce the age limit before every in-memory retry, not just
				// on load. A sync whose response was lost stays queued and is
				// retried indefinitely; once the server's idempotency receipt
				// is cleaned up (RETENTION_DAYS in src/server/cleanup.ts), a
				// late retry would re-apply the same delta. Dropping an
				// expired entry here matches the load-time TTL behavior.
				const head = this.pendingChipSyncs[0];
				if (
					typeof head.createdAt === 'number' &&
					Number.isFinite(head.createdAt) &&
					Date.now() - head.createdAt > PENDING_SYNC_MAX_AGE_MS
				) {
					console.warn('[CHIP_SYNC] Dropping expired in-memory pending sync:', head.syncId);
					this.pendingChipSyncs.shift();
					retryCount = 0;
					continue;
				}

				const result = await this.sendChipSync(this.pendingChipSyncs[0]);

				if (result === 'synced') {
					retryCount = 0;
					this.pendingChipSyncs.shift();
					continue;
				}

				if (result === 'discarded') {
					retryCount = 0;
					const discardedSync = this.pendingChipSyncs.shift();
					if (discardedSync) {
						this.discardRejectedChipSync(discardedSync);
					}
					continue;
				}

				if (result === 'retry') {
					retryCount++;
					if (retryCount >= MAX_RETRIES) {
						console.error(
							'[CHIP_SYNC] Max retries exceeded for BALANCE_MISMATCH. Leaving sync queued.',
						);
						retryCount = 0;
						break;
					}
					continue;
				}

				break;
			}
		} finally {
			this.isChipSyncInFlight = false;
			this.markPendingSyncsDirty();
			if (this.pendingChipSyncs.length > 0) {
				this.scheduleChipSyncRetry(this.chipSyncRetryDelayMs);
			}
		}
	}

	private async sendChipSync(
		sync: PendingChipSync,
	): Promise<'discarded' | 'synced' | 'retry' | 'pending'> {
		try {
			const requestBody: {
				previousBalance: number;
				delta: number;
				gameType: 'poker';
				syncId: string;
				outcome?: ChipSyncOutcome;
				handCount?: number;
				winsIncrement?: number;
				lossesIncrement?: number;
				biggestWinCandidate?: number;
			} = {
				previousBalance: sync.previousBalance,
				delta: sync.delta,
				gameType: 'poker',
				syncId: sync.syncId,
			};

			if (sync.outcome !== undefined) {
				requestBody.outcome = sync.outcome;
				requestBody.handCount = 1;
				requestBody.winsIncrement = sync.outcome === 'win' ? 1 : 0;
				requestBody.lossesIncrement = sync.outcome === 'loss' ? 1 : 0;
				requestBody.biggestWinCandidate = sync.biggestWinCandidate ?? 0;
			}

			const response = await fetch('/api/chips/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
			});

			let data: {
				balance?: number;
				currentBalance?: number;
				error?: string;
				newAchievements?: EarnedAchievement[];
			} | null = null;

			try {
				data = (await response.json()) as {
					balance?: number;
					currentBalance?: number;
					error?: string;
					newAchievements?: EarnedAchievement[];
				};
			} catch (parseError) {
				console.warn('[CHIP_SYNC] Failed to parse chip sync response JSON:', parseError);
				if (response.ok) {
					this.acknowledgeAppliedChipSync(sync, Math.max(0, sync.previousBalance + sync.delta));
					this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
					return 'synced';
				}

				if (response.status >= 400 && response.status < 500) {
					if (response.status === 409 || response.status === 429) {
						this.chipSyncRetryDelayMs = this.getChipSyncRetryDelayMs(
							response.headers?.get?.('Retry-After') ?? null,
						);
						return 'pending';
					}

					console.error('[CHIP_SYNC] Dropping permanently rejected sync', response.status);
					this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
					return 'discarded';
				}

				this.chipSyncRetryDelayMs = this.getChipSyncRetryDelayMs(
					response.headers?.get?.('Retry-After') ?? null,
				);
				return 'pending';
			}

			if (typeof data?.balance === 'number') {
				this.acknowledgeAppliedChipSync(sync, data.balance);
				this.dispatchEarnedAchievements(data.newAchievements);
				this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
				return 'synced';
			}

			if (response.ok) {
				this.acknowledgeAppliedChipSync(sync, Math.max(0, sync.previousBalance + sync.delta));
				this.dispatchEarnedAchievements(data?.newAchievements);
				this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
				return 'synced';
			}

			if (
				response.status === 409 &&
				data?.error === 'BALANCE_MISMATCH' &&
				typeof data.currentBalance === 'number'
			) {
				this.rebasePendingChipSyncBaselines(data.currentBalance);
				this.rebaseHumanTableBalance(data.currentBalance);
				this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
				return 'retry';
			}

			// Fallback for BALANCE_MISMATCH responses that do not include a numeric
			// currentBalance (the branch above handles the case with currentBalance
			// and calls rebasePendingChipSyncBaselines + rebaseHumanTableBalance).
			// Also covers 429 rate-limit responses. Both cases defer the sync.
			if (
				response.status === 429 ||
				(response.status === 409 && data?.error === 'BALANCE_MISMATCH')
			) {
				this.chipSyncRetryDelayMs = this.getChipSyncRetryDelayMs(
					response.headers?.get?.('Retry-After') ?? null,
				);
				console.warn('[CHIP_SYNC] Sync deferred after transient response', response.status);
				return 'pending';
			}

			if (response.status >= 400 && response.status < 500) {
				console.error(
					'[CHIP_SYNC] Dropping permanently rejected sync',
					response.status,
					data?.error,
				);
				this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
				return 'discarded';
			}

			this.chipSyncRetryDelayMs = this.getChipSyncRetryDelayMs(
				response.headers?.get?.('Retry-After') ?? null,
			);
			return 'pending';
		} catch (error) {
			console.error('[CHIP_SYNC] Network error syncing chips to server:', error);
			this.chipSyncRetryDelayMs = CHIP_SYNC_RETRY_DELAY_MS;
			return 'pending';
		}
	}

	private buildAIConfig(personality: AIPersonality, difficulty: AIDifficulty): AIConfig {
		const base = createAIConfig(personality, difficulty);
		return this.aiRandom ? { ...base, random: this.aiRandom } : base;
	}

	private initPlayers() {
		const settings = this.settingsManager.getSettings();
		this.players = [
			createPlayer(0, 'You', this.getEffectiveServerBalance(), false),
			createAIPlayer(1, 'Player 2', settings.startingChips),
			createAIPlayer(2, 'Player 3', settings.startingChips),
		];
		this.players[this.dealerIndex].isDealer = true;

		// Assign AI personalities and difficulties from settings
		this.aiConfigs.set(1, this.buildAIConfig(settings.aiPersonality1, settings.aiDifficulty1));
		this.aiConfigs.set(2, this.buildAIConfig(settings.aiPersonality2, settings.aiDifficulty2));

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
		if (this.isGuestMode) {
			return null;
		}

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
		this.cancelPendingAutoDeal();
		this.cancelPendingTurnTransitions();

		// Clear LLM cache for new hand
		clearLLMCache();

		const settings = this.settingsManager.getSettings();

		// If LLM-powered AI is enabled, ensure the user has a valid API key configured
		if (settings.useLLMAI && !this.isGuestMode) {
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

		if (!this.hasServerSyncedBalance) {
			this.updateGameStatus('Unable to load your chip balance. Refresh the page to try again.');
			return;
		}

		const preExistingPendingCount = this.pendingChipSyncs.length;
		this.finalizeActiveHandBeforeDeal();

		if (preExistingPendingCount > 0 && this.pendingChipSyncs.length > 0) {
			if (this.dealSyncRetryCount >= MAX_DEAL_SYNC_RETRIES) {
				this.dealSyncRetryCount = 0;
				this.updateGameStatus('Unable to sync chip balance. Please refresh the page.');
				return;
			}
			this.dealSyncRetryCount++;
			this.updateGameStatus('Syncing chip balance...');
			this.scheduleAutoDeal(1000);
			return;
		}
		this.dealSyncRetryCount = 0;

		// Check for eliminated players (0 chips)

		// Apply pending chip reset if settings were changed
		if (this.pendingChipReset) {
			const effectiveServerBalance = this.getEffectiveServerBalance();
			this.players = this.players.map((p) =>
				p.id === 0
					? { ...p, chips: effectiveServerBalance }
					: { ...p, chips: settings.startingChips },
			);
			this.pendingChipReset = false;
			this.updateGameStatus(`Chip stacks reset for new game`);
		}

		const eliminatedPlayers = this.players.filter((p) => p.chips === 0);
		if (eliminatedPlayers.length > 0) {
			const effectiveServerBalance = this.getEffectiveServerBalance();
			for (const player of eliminatedPlayers) {
				if (player.id === 0) {
					if (effectiveServerBalance <= 0) {
						this.updateGameStatus('Game Over - You ran out of chips!');
						// Rebuy is guest-only; authed balances live on the server and
						// must be topped up through missions or other server flows.
						if (this.isGuestMode) {
							this.showRebuyButton();
						}
						return; // Stop the game
					}
					this.players[0] = { ...this.players[0], chips: effectiveServerBalance };
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

		// Capture human chip count before blinds are posted (used for delta calculation at hand end)
		this.humanChipsBefore = this.players[0].chips;

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
		this.hideRebuyButton();

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus('Your turn! Check, Call, Raise, or Fold');
			this.updateActionButtons();
		} else {
			this.updateGameStatus(`Waiting for ${this.players[this.currentPlayerIndex].name}...`);
			this.updateActionButtons();
			this.processAITurn();
		}
	}

	private async processAITurn() {
		if (this.isProcessingAction) return;
		if (this.currentPlayerIndex === 0) return; // Not AI's turn

		const turnTransitionToken = this.turnTransitionToken;

		// AI decision delay based on settings
		const aiDelay = this.settingsManager.getAIDelay();
		const delay = aiDelay.min + Math.random() * (aiDelay.max - aiDelay.min);
		const transitionCompleted = await this.waitForTurnTransition(delay, turnTransitionToken);
		if (!transitionCompleted) return;
		if (turnTransitionToken !== this.turnTransitionToken) return;
		if (this.currentPlayerIndex === 0) return;

		const currentPlayer = this.players[this.currentPlayerIndex];
		if (!currentPlayer || !currentPlayer.isAI) return;

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

		// Build game context for AI. Opponent hole cards are stripped so the AI
		// context never carries hidden information — defense-in-depth against any
		// future strategy module accidentally reading opponent hands.
		const sanitizedPlayers = this.players.map((p) =>
			p.id === currentPlayer.id ? p : { ...p, hand: [] },
		);
		const context: GameContext = {
			player: currentPlayer,
			players: sanitizedPlayers,
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

		if (settings.useLLMAI && !this.isGuestMode) {
			// Try LLM-based AI with fallback to rule-based
			const llmSettings = await this.getLLMSettings();
			if (turnTransitionToken !== this.turnTransitionToken) return;
			decision = await makeLLMDecision(
				context,
				aiConfig.personality,
				llmSettings,
				aiConfig.difficulty,
			);
			if (turnTransitionToken !== this.turnTransitionToken) return;
		} else {
			// Use rule-based AI
			decision = makeAIDecision(context, aiConfig);
		}

		if (turnTransitionToken !== this.turnTransitionToken) return;

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
				if (callAmount > 0) {
					// placeBet() clamps to remaining chips and marks the player all-in,
					// so short stacks can call all-in instead of being forced to fold.
					const actualCall = Math.min(callAmount, currentPlayer.chips);
					this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
					this.pot = calculatePot(this.players);
					const allInNote = this.players[this.currentPlayerIndex].isAllIn ? ' (all-in)' : '';
					this.updateGameStatus(`${currentPlayer.name} calls $${actualCall}${allInNote}`);
					this.ui.showAIDecision(currentPlayer.id, 'call', actualCall);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// No bet to call - treat as a check
					this.players[this.currentPlayerIndex] = { ...currentPlayer, hasActed: true };
					this.updateGameStatus(`${currentPlayer.name} checks`);
					this.ui.showAIDecision(currentPlayer.id, 'check');
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
					// Can't afford to raise, call instead (placeBet clamps to all-in)
					if (callAmount > 0) {
						const actualCall = Math.min(callAmount, currentPlayer.chips);
						this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
						this.pot = calculatePot(this.players);
						const allInNote = this.players[this.currentPlayerIndex].isAllIn ? ' (all-in)' : '';
						this.updateGameStatus(`${currentPlayer.name} calls $${actualCall}${allInNote}`);
						this.ui.showAIDecision(currentPlayer.id, 'call', actualCall);
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
			this.scheduleTurnTransition(1000, () => this.nextPhase());
			return;
		}

		// Move to next player
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.currentPlayerIndex);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus('Your turn!');
			this.updateActionButtons();
		} else {
			this.updateGameStatus(`Waiting for ${this.players[this.currentPlayerIndex].name}...`);
			this.updateActionButtons();
			this.processAITurn();
		}
	}

	private getPlayerPosition(player: Player): 'early' | 'middle' | 'late' {
		const dealerIndex = this.dealerIndex;
		const playerIndex = this.players.findIndex((p) => p.id === player.id);
		const positionFromDealer =
			(playerIndex - dealerIndex + this.players.length) % this.players.length;

		if (positionFromDealer === 0) return 'late';
		// 3-handed: dealer=late, the seat immediately after the dealer acts first
		// postflop (early), and the remaining seat is middle. Without this special
		// case both non-dealer seats collapse to 'early' and 'middle' is unreachable.
		if (this.players.length === 3) {
			return positionFromDealer === 1 ? 'early' : 'middle';
		}
		return positionFromDealer <= 2 ? 'early' : positionFromDealer === 3 ? 'middle' : 'late';
	}

	private updateGameStatus(message: string) {
		this.ui.updateGameStatus(message, this.gamePhase, this.pot);
	}

	private updateActionButtons() {
		const btnFold = document.getElementById('btn-fold') as HTMLButtonElement | null;
		const btnCheck = document.getElementById('btn-check') as HTMLButtonElement | null;
		const btnCall = document.getElementById('btn-call') as HTMLButtonElement | null;
		const btnRaise = document.getElementById('btn-raise') as HTMLButtonElement | null;

		if (!btnFold || !btnCheck || !btnCall || !btnRaise) return;

		const humanPlayer = this.players[0];
		const isHumanTurn = this.currentPlayerIndex === 0;

		if (
			!humanPlayer ||
			this.isProcessingAction ||
			!isHumanTurn ||
			humanPlayer.folded ||
			humanPlayer.isAllIn
		) {
			btnFold.disabled = true;
			btnCheck.disabled = true;
			btnCall.disabled = true;
			btnRaise.disabled = true;
			return;
		}

		const highestBet = getHighestBet(this.players);
		const callAmount = getCallAmount(humanPlayer, highestBet);

		btnFold.disabled = false;
		btnCheck.disabled = callAmount > 0;
		// Keep Call enabled when the human has chips even if callAmount exceeds
		// their stack: placeBet() clamps to remaining chips and marks the player
		// all-in, so a short stack can still call off their stack through the UI.
		btnCall.disabled = callAmount <= 0 || humanPlayer.chips <= 0;
		btnRaise.disabled = humanPlayer.chips <= 0;
	}

	/**
	 * Builds the showdown status message from per-tier results. Distinguishes
	 * a genuine split-pot tie (multiple winners within one tier) from separate
	 * winners of different tiers (e.g. short stack wins main, covering player
	 * wins side), and reports each tier's amount instead of the total pot.
	 */
	private formatShowdownMessage(tierResults: TierResult[]): string {
		if (tierResults.length === 0) return 'Showdown complete.';
		if (tierResults.length === 1) {
			const { amount, winners } = tierResults[0];
			if (winners.length === 1) {
				return `${winners[0].name} wins $${amount}! 🎉`;
			}
			const names = winners.map((w) => w.name).join(', ');
			return `Tie! ${names} split the $${amount} pot 🤝`;
		}
		// Multiple tiers: label main vs side pots and list each tier's winner(s).
		const parts = tierResults.map((tier, i) => {
			const label = i === 0 ? 'Main pot' : `Side pot ${i}`;
			if (tier.winners.length === 1) {
				return `${label}: ${tier.winners[0].name} wins $${tier.amount}`;
			}
			const names = tier.winners.map((w) => w.name).join(' & ');
			return `${label}: ${names} split $${tier.amount}`;
		});
		return parts.join(' | ');
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
			// Only sync when the human won (AI winning sole-survivor hands needs no sync)
			if (winner.id === 0) {
				this.syncChips('win');
			}
			this.scheduleAutoDeal(3000);
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
				// Only one player left - they win by default (folded on river)
				const winner = activePlayers[0];
				this.players[winner.id] = awardChips(winner, this.pot);
				this.updateGameStatus(`${winner.name} wins $${this.pot}! 🎉`);
				if (winner.id === 0) {
					this.syncChips('win');
				}
			} else {
				// Multiple players - resolve pots with side-pot eligibility so a
				// short all-in can only win up to the tiers they contributed to.
				const { awards, tierWinners, tierResults } = resolveSidePotAwards(
					this.players,
					this.communityCards,
					determineShowdownWinners,
				);

				// Reveal opponent hands at showdown (across all tiers)
				this.ui.revealOpponentHands(this.players, tierWinners);

				// Apply awards
				for (const [playerId, amount] of awards.entries()) {
					const player = this.players.find((p) => p.id === playerId);
					if (player) {
						this.players[playerId] = awardChips(player, amount);
					}
				}

				// Status message. Distinguish a genuine split-pot tie (multiple
				// winners within one tier) from separate winners of different
				// tiers (e.g. short stack wins main, covering player wins side).
				this.updateGameStatus(this.formatShowdownMessage(tierResults));

				// Sync based on the human's net chip delta for the hand (accurate
				// across side pots where the human may win some tiers and lose others)
				if (!this.players[0].folded) {
					const humanDelta = this.players[0].chips - this.humanChipsBefore;
					const outcome: ChipSyncOutcome =
						humanDelta > 0 ? 'win' : humanDelta < 0 ? 'loss' : 'push';
					this.syncChips(outcome);
				}
			}
			this.pot = 0;
			this.ui.updateUI(this.pot, this.players[0]);
			this.ui.updateOpponentUI(this.players);
			// Auto-deal new hand after 3 seconds
			this.scheduleAutoDeal(3000);
			return;
		}

		// Start new betting round from dealer
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.dealerIndex);

		this.ui.renderCommunityCards(this.communityCards);
		this.ui.renderPlayerCards(this.players[0], this.communityCards);
		this.ui.updateUI(this.pot, this.players[0]);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus('Your turn!');
			this.updateActionButtons();
		} else {
			this.updateGameStatus(`Waiting for ${this.players[this.currentPlayerIndex].name}...`);
			this.updateActionButtons();
			this.processAITurn();
		}
	}

	private showRebuyButton(): void {
		const rebuyBtn = document.getElementById('btn-rebuy') as HTMLButtonElement | null;
		if (rebuyBtn) {
			rebuyBtn.hidden = false;
		}
	}

	private hideRebuyButton(): void {
		const rebuyBtn = document.getElementById('btn-rebuy') as HTMLButtonElement | null;
		if (rebuyBtn) {
			rebuyBtn.hidden = true;
		}
	}

	/**
	 * Reset a busted guest's bankroll to the default guest balance and deal a
	 * fresh hand. Authenticated players cannot rebuy client-side — their chip
	 * balance lives on the server and must be topped up through missions or
	 * other server-side flows.
	 */
	private async rebuyBustedGuest(): Promise<void> {
		if (!this.isGuestMode) return;

		this.serverSyncedBalance = DEFAULT_GUEST_GAME_BALANCE;
		persistGuestBankroll(
			PokerGame.GUEST_BANKROLL_GAME_KEY,
			this.clientUserId,
			DEFAULT_GUEST_GAME_BALANCE,
		);

		// Reflect the restored balance in the DOM before dealing.
		this.players[0] = { ...this.players[0], chips: DEFAULT_GUEST_GAME_BALANCE };
		this.ui.updateUI(this.pot, this.players[0]);
		this.hideRebuyButton();
		await this.dealNewHand();
	}

	private attachEventListeners() {
		document.getElementById('btn-deal')?.addEventListener('click', () => this.dealNewHand());
		document.getElementById('btn-rebuy')?.addEventListener('click', () => this.rebuyBustedGuest());

		document.getElementById('btn-fold')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			this.isProcessingAction = true;
			this.updateActionButtons();

			try {
				this.players[0] = foldPlayer(this.players[0]);
				this.ui.updateUI(this.pot, this.players[0]);
				this.updateGameStatus('You folded');
				// Sync immediately — human chip count is now locked in for this hand
				this.syncChips('loss');
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		document.getElementById('btn-check')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			const highestBet = getHighestBet(this.players);
			const callAmount = getCallAmount(this.players[0], highestBet);

			if (callAmount > 0) {
				return;
			}

			this.isProcessingAction = true;
			this.updateActionButtons();
			try {
				this.players[0] = { ...this.players[0], hasActed: true };
				this.updateGameStatus('You checked');
			} finally {
				this.scheduleTurnTransition(200, () => {
					this.isProcessingAction = false;
					this.advanceTurn();
				});
			}
		});

		document.getElementById('btn-call')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			const highestBet = getHighestBet(this.players);
			const callAmount = getCallAmount(this.players[0], highestBet);

			if (callAmount <= 0) {
				return;
			}

			this.isProcessingAction = true;
			this.updateActionButtons();
			try {
				// placeBet() clamps to remaining chips and marks the player all-in.
				const actualCall = Math.min(callAmount, this.players[0].chips);
				this.players[0] = placeBet(this.players[0], callAmount);
				this.pot = calculatePot(this.players);
				this.ui.updateUI(this.pot, this.players[0]);
				const allInNote = this.players[0].isAllIn ? ' (all-in)' : '';
				this.updateGameStatus(`You called $${actualCall}${allInNote}`);
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		document.getElementById('btn-raise')?.addEventListener('click', () => {
			if (this.isProcessingAction || this.currentPlayerIndex !== 0) return;
			this.isProcessingAction = true;
			this.updateActionButtons();

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
			const aiDifficulty1El = document.getElementById(
				'setting-ai-difficulty-1',
			) as HTMLSelectElement | null;
			const aiDifficulty2El = document.getElementById(
				'setting-ai-difficulty-2',
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
				!aiDifficulty1El ||
				!aiDifficulty2El ||
				!useLLMAIEl
			) {
				console.error('Settings form is missing required elements');
				this.updateGameStatus('Error: Settings form is incomplete. Please refresh the page.');
				return;
			}

			// Parse and validate values. Enum values from <select> elements are
			// validated against their domain and fall back to the current setting
			// if the DOM is malformed.
			const startingChips = parseInt(startingChipsEl.value || '500');
			const smallBlind = parseInt(smallBlindEl.value || '5');
			const bigBlind = parseInt(bigBlindEl.value || '10');
			const currentSettings = this.settingsManager.getSettings();
			const aiSpeed = isAISpeed(aiSpeedEl.value) ? aiSpeedEl.value : currentSettings.aiSpeed;
			const aiPersonality1 = isAIPersonality(aiPersonality1El.value)
				? aiPersonality1El.value
				: currentSettings.aiPersonality1;
			const aiPersonality2 = isAIPersonality(aiPersonality2El.value)
				? aiPersonality2El.value
				: currentSettings.aiPersonality2;
			const aiDifficulty1: AIDifficultySetting = isAIDifficulty(aiDifficulty1El.value)
				? aiDifficulty1El.value
				: currentSettings.aiDifficulty1;
			const aiDifficulty2: AIDifficultySetting = isAIDifficulty(aiDifficulty2El.value)
				? aiDifficulty2El.value
				: currentSettings.aiDifficulty2;
			const useLLMAI = this.isGuestMode ? false : useLLMAIEl.checked;

			this.settingsManager.updateSettings({
				startingChips,
				smallBlind,
				bigBlind,
				aiSpeed,
				aiPersonality1,
				aiPersonality2,
				aiDifficulty1,
				aiDifficulty2,
				useLLMAI,
			});

			// Update AI configs
			this.aiConfigs.set(1, this.buildAIConfig(aiPersonality1, aiDifficulty1));
			this.aiConfigs.set(2, this.buildAIConfig(aiPersonality2, aiDifficulty2));

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
			this.aiConfigs.set(1, this.buildAIConfig(defaults.aiPersonality1, defaults.aiDifficulty1));
			this.aiConfigs.set(2, this.buildAIConfig(defaults.aiPersonality2, defaults.aiDifficulty2));

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
		const aiDifficulty1Select = document.getElementById(
			'setting-ai-difficulty-1',
		) as HTMLSelectElement | null;
		const aiDifficulty2Select = document.getElementById(
			'setting-ai-difficulty-2',
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
		if (aiDifficulty1Select) aiDifficulty1Select.value = settings.aiDifficulty1;
		if (aiDifficulty2Select) aiDifficulty2Select.value = settings.aiDifficulty2;
		if (useLLMAICheckbox) {
			useLLMAICheckbox.checked = this.isGuestMode ? false : settings.useLLMAI;
			useLLMAICheckbox.disabled = this.isGuestMode;
			useLLMAICheckbox.title = this.isGuestMode
				? 'Sign in to use profile-backed LLM AI opponents.'
				: '';
			const llmHelpText = useLLMAICheckbox.parentElement?.querySelector('.text-xs');
			if (llmHelpText) {
				llmHelpText.textContent = this.isGuestMode
					? 'Sign in to use profile-backed OpenAI/Gemini opponents.'
					: 'Enable OpenAI/Gemini for smarter, more human-like AI play. Requires API key configured in profile.';
			}
		}
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
