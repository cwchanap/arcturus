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
	getPlayersWhoCanAct,
	canPlayerAct,
	getNextPlayerIndex,
	isBettingRoundComplete,
	getHighestBet,
	getCallAmount,
	calculatePot,
	calculateSidePots,
	contestablePot,
	resolveSidePotAwards,
	determineShowdownWinners,
	createAIConfig,
	isAIDifficulty,
	makeAIDecision,
	mergeTiersByWinners,
} from './index';
import {
	HAND_RANKINGS,
	NUM_PLAYERS,
	MAX_BET,
	SMALL_BLIND,
	POKER_HAND_SETTLED_EVENT,
} from './constants';
import { readHand } from './handReadout';
import {
	loadSessionStats,
	recordHand,
	saveSessionStats,
	type PokerSessionStats,
} from './sessionStats';
import { HandRecapRecorder, type RecapAction, type RecapReveal } from './handRecap';
import {
	SNG_BLINDS,
	SNG_START_STACK,
	humanPlace,
	levelFor,
	nextFundedSeats,
	placeLabel,
	type PokerMode,
} from './sitAndGo';
import { pokerSound, type PokerSfx, type PokerSound } from './sound';
import { TURN_TIMER_STORAGE_KEY, TurnTimer } from './turnTimer';
import { DEFAULT_SETTINGS } from './types';
import { DeckManager } from './DeckManager';
import { PokerUIRenderer } from './PokerUIRenderer';
import { AIRivalAssistant } from './AIRivalAssistant';
import { GameSettingsManager, isAIPersonality, isAISpeed } from './GameSettingsManager';
import { makeLLMDecision, clearLLMCache } from './llmAIStrategy';
import { loadAiSettings, type AiSettings } from '../ai';
import { formatWholeNumber } from '../formatting';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import { getPokerHandName, pokerTranslator } from '../i18n/messages/poker';
import {
	DEFAULT_GUEST_GAME_BALANCE,
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
} from '../public-game-session';
import {
	createSettlementGate,
	ensureSettlementRecoveryControls,
	newSettlementId,
	type SettlementGate,
	type SettleRoundCommand,
	type SettleRoundResult,
} from '../wallet';

export type PokerSettlementOutcome = 'win' | 'loss' | 'push';

/** Build the one wallet command for a completed single-player Poker hand. */
export function buildPokerSettlementCommand(
	delta: number,
	outcome: PokerSettlementOutcome,
): SettleRoundCommand {
	return {
		settlementId: newSettlementId('poker'),
		game: 'poker',
		delta,
		stats: {
			rounds: 1,
			wins: outcome === 'win' ? 1 : 0,
			losses: outcome === 'loss' ? 1 : 0,
			biggestWin: outcome === 'win' ? Math.max(0, delta) : 0,
		},
	};
}

type AIDifficultySetting = GameSettings['aiDifficulty1'];

/** How long a finished hand stays on screen before auto-deal (when enabled). */
export const AUTO_DEAL_DELAY_MS = 5000;
export const AUTO_DEAL_STORAGE_KEY = 'poker_auto_deal';

/** Action sound effect played for each seat action. */
const ACTION_SFX: Record<RecapAction, PokerSfx> = {
	fold: 'fold',
	check: 'check',
	call: 'chips',
	raise: 'raise',
};

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
	// Blinds posted for the current hand. Settings saves apply to the next
	// deal, so raise legality and the toolbar read this stable baseline.
	private handSmallBlind = SMALL_BLIND;
	private handBigBlind = BIG_BLIND;
	private isProcessingAction = false;
	private aiConfigs: Map<number, AIConfig> = new Map();
	private aiRandom?: () => number;
	private pendingChipReset = false; // Flag to reset chips on next deal
	private hasServerSyncedBalance = false;
	private serverSyncedBalance: number = 0; // Last confirmed server chip balance
	private humanChipsBefore: number = 0; // Human chip count at start of current hand (before blinds)
	// Same baseline for presentation; unlike humanChipsBefore it survives settlement.
	private handStartChips = 0;
	// Per-seat stacks at hand start (before blinds), so seat floats can show
	// each player's net change for the hand like the human's delta float.
	private handStartStacks = new Map<number, number>();
	// The hand-local delta frozen when the human's outcome becomes final. Once
	// settlement is adopted, players[0].chips becomes the reconciled account
	// balance — recomputing the delta then would leak unrelated balance changes
	// into the result banner and session tally.
	private handResultDelta: number | null = null;
	private handNumber = 0;
	private handInProgress = false;
	private lastAnnouncedRank = -1;
	private sessionStats: PokerSessionStats;
	private autoDealEnabled = false;
	private settlementGate: SettlementGate;
	private readonly sound: PokerSound;
	private readonly recap = new HandRecapRecorder();
	private readonly turnTimer: TurnTimer;
	private turnTimerEnabled = true;
	// Whether the human could act at the last button refresh; its rising edge
	// starts their turn (chime + countdown).
	private humanTurnLive = false;
	private autoDealTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private autoDealToken = 0;
	private turnTransitionTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private pendingTurnTransitionResolver: ((completed: boolean) => void) | null = null;
	private turnTransitionToken = 0;
	private isGuestMode = false;
	private mode: PokerMode = 'cash';
	// Human's finish place once the Sit & Go ends; null while it runs. The
	// localized terminal status and panel render from this at tournament end.
	private finishedPlace: number | null = null;
	private clientUserId = '';
	private readonly locale: Locale;
	private readonly t: ReturnType<typeof pokerTranslator>;
	private static readonly GUEST_BANKROLL_GAME_KEY = 'poker';

	constructor(aiRandom?: () => number, settlementGate?: SettlementGate, sound?: PokerSound) {
		this.aiRandom = aiRandom;
		this.settlementGate = settlementGate ?? createSettlementGate();
		this.sound = sound ?? pokerSound;
		this.turnTimer = new TurnTimer({
			onTick: (fraction, secondsLeft) => this.ui.renderTurnTimer(fraction, secondsLeft),
			onWarn: () => this.sound.play('tick'),
			onExpire: () => this.actOnTimeout(),
		});
		// AppLayout writes data-locale on <html>; the game reads it so browser
		// and SSR share one locale handoff for status/phase/pot copy.
		this.locale = getDocumentLocale();
		this.t = pokerTranslator(this.locale);
		this.deck = new DeckManager();
		this.ui = new PokerUIRenderer();
		this.aiRival = new AIRivalAssistant();
		this.settingsManager = new GameSettingsManager();
		this.sessionStats = loadSessionStats();
		this.autoDealEnabled = PokerGame.loadAutoDealPreference();
		this.turnTimerEnabled = PokerGame.loadTurnTimerPreference();

		// Seed serverSyncedBalance from the server-rendered DOM value
		const balanceEl = document.getElementById('player-balance');
		const rootEl = document.getElementById('poker-root');
		this.isGuestMode =
			isGuestModeValue(balanceEl?.dataset?.guestMode) ||
			isGuestModeValue(rootEl?.dataset?.guestMode);
		this.mode = rootEl?.dataset?.pokerMode === 'sng' ? 'sng' : 'cash';
		const balanceAvailable = balanceEl?.dataset?.balanceAvailable;
		const rawBalance = balanceEl?.dataset?.balance ?? balanceEl?.textContent ?? '';
		// Strip locale formatting (commas, currency symbols) then parse
		const sanitized = rawBalance.replace(/[^0-9.-]/g, '');
		const hasDigit = /[0-9]/.test(sanitized);
		const parsed = hasDigit ? Number(sanitized) : Number.NaN;
		this.hasServerSyncedBalance =
			this.playsLocally || (balanceAvailable === 'false' ? false : Number.isFinite(parsed));
		this.serverSyncedBalance = this.hasServerSyncedBalance ? Math.trunc(parsed) : 0;

		const userId = balanceEl?.dataset?.userId ?? '';
		this.clientUserId = userId;

		if (this.mode === 'sng') {
			// Tournament chips replace every cash baseline: account balance and
			// guest bankroll are never consulted for Sit & Go play.
			this.serverSyncedBalance = SNG_START_STACK;
		} else if (this.isGuestMode && this.hasServerSyncedBalance) {
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
		if (this.isGuestMode && this.mode === 'cash' && this.hasServerSyncedBalance) {
			this.ui.updateUI(this.pot, this.players[0]);
		}
		this.attachEventListeners();
		this.ensureSettlementRecoveryControls();
		this.wireSettlementRecoveryControls();
		this.attachSettingsListeners();
		this.renderSettingsPanel();
		this.updateBetControls(true);
		this.updateActionButtons();
		this.aiRival.highlightSuggestedMove(null);
		this.ui.renderSessionStats(this.sessionStats);
		this.renderRivals();

		if (!this.hasServerSyncedBalance) {
			const dealButton = document.getElementById('btn-deal') as HTMLButtonElement | null;
			if (dealButton) {
				dealButton.disabled = true;
			}
			this.updateGameStatus(this.t('errorBalanceUnavailable'));
		}

		// On load, if LLM AI is enabled but no key is configured, show overlay immediately
		void this.checkLlmConfigOnLoad();

		window.addEventListener('beforeunload', () => {
			if (this.isGuestMode && this.mode === 'cash') this.persistGuestBankroll();
		});
	}

	/** Guest cash play and Sit & Go are both fully local: no wallet, account balance, or LLM access. */
	private get playsLocally(): boolean {
		return this.isGuestMode || this.mode === 'sng';
	}

	/** The human's Sit & Go finish place, or null while the tournament runs. */
	public get tournamentPlace(): number | null {
		return this.finishedPlace;
	}

	private getEffectiveServerBalance(): number {
		return Math.max(0, this.serverSyncedBalance);
	}

	private static loadAutoDealPreference(): boolean {
		try {
			return localStorage.getItem(AUTO_DEAL_STORAGE_KEY) === 'true';
		} catch {
			return false;
		}
	}

	private static loadTurnTimerPreference(): boolean {
		try {
			return localStorage.getItem(TURN_TIMER_STORAGE_KEY) !== 'false';
		} catch {
			return true;
		}
	}

	private setTurnTimer(enabled: boolean): void {
		this.turnTimerEnabled = enabled;
		try {
			localStorage.setItem(TURN_TIMER_STORAGE_KEY, String(enabled));
		} catch {
			// Preference is a convenience; the toggle still works for this page.
		}
		if (enabled && this.humanTurnLive) this.startTurnTimer();
		else if (!enabled) this.stopTurnTimer();
		this.renderToggles();
	}

	/** Toolbar icon toggles reflect their state through aria-pressed. */
	private renderToggles(): void {
		document
			.getElementById('btn-sound')
			?.setAttribute?.('aria-pressed', String(!this.sound.isMuted()));
		document
			.getElementById('btn-turn-timer')
			?.setAttribute?.('aria-pressed', String(this.turnTimerEnabled));
	}

	/**
	 * Count down the human's turn. Only while the page is visible: a
	 * background tab should never act for the player.
	 */
	private startTurnTimer(): void {
		if (!this.turnTimerEnabled || document.visibilityState !== 'visible') return;
		this.turnTimer.start();
	}

	private stopTurnTimer(): void {
		this.turnTimer.stop();
		this.ui.renderTurnTimer(null, 0);
	}

	/** Time ran out: take the free check, otherwise fold. */
	private actOnTimeout(): void {
		this.ui.renderTurnTimer(null, 0);
		// A panel is open (settings, history, recap): give them a fresh clock
		// rather than act while they cannot see the table.
		if (document.querySelector('dialog[open]')) {
			this.startTurnTimer();
			return;
		}
		const check = document.getElementById('btn-check') as HTMLButtonElement | null;
		if (check && !check.hidden && !check.disabled) check.click();
		else document.getElementById('btn-fold')?.click();
	}

	/** The human's turn starts or ends with each button refresh. */
	private syncHumanTurn(live: boolean): void {
		if (live === this.humanTurnLive) return;
		this.humanTurnLive = live;
		if (live) {
			this.sound.play('turn');
			this.startTurnTimer();
		} else {
			this.stopTurnTimer();
		}
	}

	/** Record an action for the recap and play its sound. */
	private noteAction(playerId: number, action: RecapAction, amount = 0): void {
		const allIn = (action === 'call' || action === 'raise') && !!this.players[playerId]?.isAllIn;
		this.recap.act({ playerId, action, amount, allIn });
		this.sound.play(allIn ? 'allIn' : ACTION_SFX[action]);
	}

	/** Show an AI decision on its seat and note it. */
	private showDecision(playerId: number, action: RecapAction, amount?: number): void {
		this.ui.showAIDecision(playerId, action, amount);
		this.noteAction(playerId, action, amount ?? 0);
	}

	/** Seat names and rival styles for the recap's avatars. */
	private recapSeats(): Map<number, { name: string; style: AIPersonality | null }> {
		return new Map(
			this.players.map((player) => [
				player.id,
				{ name: player.name, style: this.aiConfigs.get(player.id)?.personality ?? null },
			]),
		);
	}

	private setAutoDeal(enabled: boolean): void {
		this.autoDealEnabled = enabled;
		try {
			localStorage.setItem(AUTO_DEAL_STORAGE_KEY, String(enabled));
		} catch {
			// Preference is a convenience; the toggle still works for this page.
		}
		if (!enabled) this.cancelPendingAutoDeal();
		else if (this.handNumber > 0 && !this.handInProgress) this.scheduleAutoDeal(AUTO_DEAL_DELAY_MS);
		this.updateActionButtons();
	}

	private renderRivals(): void {
		this.ui.renderRivals(
			[...this.aiConfigs].map(([id, config]) => ({
				id,
				personality: config.personality,
				difficulty: config.difficulty,
			})),
		);
	}

	/**
	 * Present the end of a hand: banner over the pot, winning cards, seat
	 * deltas, hand names, and the session tally. `awards` maps player id to
	 * chips collected; `tiers` holds each pot tier's own winners, which is the
	 * only reliable source of ties (separate main/side pot winners are not a
	 * split, and an odd chip can pay a genuine tie unevenly); `showdown` is
	 * false when everyone else folded.
	 */
	private presentHandResult(
		awards: Map<number, number>,
		tiers: TierResult[],
		showdown: boolean,
	): void {
		const human = this.players[0];
		const delta = this.handResultDelta ?? human.chips - this.handStartChips;
		// A tier made of a single player's chips returns their uncalled bet;
		// excluding it keeps returned chips out of win attribution. The award
		// itself is untouched — the bettor still gets those chips back.
		const contestedTiers = tiers.filter((tier) => !tier.uncontested);
		// If every tier is a lone contributor's chips (only one player ever bet),
		// the return is the whole result — show it rather than an empty banner.
		const displayTiers = contestedTiers.length > 0 ? contestedTiers : tiers;
		const returnedByPlayer = new Map<number, number>();
		if (contestedTiers.length > 0) {
			for (const tier of tiers) {
				if (!tier.uncontested) continue;
				for (const winner of tier.winners) {
					returnedByPlayer.set(winner.id, (returnedByPlayer.get(winner.id) ?? 0) + tier.amount);
				}
			}
		}
		const contestedAward = (playerId: number) =>
			Math.max(0, (awards.get(playerId) ?? 0) - (returnedByPlayer.get(playerId) ?? 0));
		const humanWon = contestedAward(0);
		const winnerIds = new Set(
			displayTiers.flatMap((tier) => tier.winners.map((player) => player.id)),
		);
		const humanTiers = displayTiers.filter((tier) =>
			tier.winners.some((player) => player.id === 0),
		);
		const humanSplit = humanTiers.length > 0 && humanTiers.every((tier) => tier.winners.length > 1);
		// Headline the largest contested pot (the main pot on equal amounts).
		const headline = mergeTiersByWinners(displayTiers).reduce<TierResult | null>(
			(top, tier) => (!top || tier.amount > top.amount ? tier : top),
			null,
		);
		const headliners = this.players.filter((player) =>
			headline?.winners.some((winner) => winner.id === player.id),
		);
		const total = [...awards.keys()].reduce((sum, id) => sum + contestedAward(id), 0);

		let title: string;
		if (humanWon > 0 && delta > 0) {
			title = this.t(humanSplit ? 'resultYouSplit' : 'resultYouWin', {
				amount: formatChips(humanWon, this.locale),
			});
		} else if (humanWon > 0) {
			// Won a pot but the hand netted zero or less: keep the award visible
			// without claiming a win the loss delta would contradict.
			title = this.t('resultYouTake', { amount: formatChips(humanWon, this.locale) });
		} else if (headline && headliners.length > 1) {
			title = this.t('resultSplit', {
				names: headliners.map((player) => player.name).join(' & '),
				amount: formatChips(headline.amount, this.locale),
			});
		} else {
			title = this.t('resultPlayerWins', {
				name: headliners[0]?.name ?? '',
				amount: formatChips(contestedAward(headliners[0]?.id ?? -1) || total, this.locale),
			});
		}

		const featured = humanWon > 0 ? human : headliners[0];
		const featuredHand = showdown && featured ? readHand(featured.hand, this.communityCards) : null;
		const detail = featuredHand
			? getPokerHandName(this.locale, featuredHand.key)
			: !showdown
				? this.t('resultEveryoneFolded')
				: '';
		const involved = this.handStartChips > 0;
		this.ui.showHandResult({
			title,
			detail:
				human.folded && humanWon === 0 && detail
					? `${detail} · ${this.t('resultYouFolded')}`
					: detail,
			tone: delta > 0 ? 'win' : delta < 0 ? 'loss' : 'neutral',
			delta: involved ? delta : null,
		});

		if (showdown) {
			for (const player of this.players.slice(1)) {
				if (player.folded) continue;
				const readout = readHand(player.hand, this.communityCards);
				if (readout) this.ui.setSeatHand(player.id, readout.key, winnerIds.has(player.id));
			}
			this.ui.highlightWinningCards(this.communityCards, this.players, winnerIds);
		}
		if (involved) {
			// Seat floats show each player's net change for the hand — a pot
			// award is gross of the bets it repays, so a loser who collected a
			// small pot shows their real loss rather than "+amount".
			for (const player of this.players.slice(1)) {
				const start = this.handStartStacks.get(player.id);
				if (start !== undefined) this.ui.showChipDelta(player.id, player.chips - start);
			}
			this.ui.showChipDelta(0, delta);
		}

		// Tournament hands stay out of the cash session tally entirely: the
		// localStorage write and the toolbar render share this gate.
		if (involved && this.mode === 'cash') {
			const humanHand =
				showdown && !human.folded ? readHand(human.hand, this.communityCards) : null;
			this.sessionStats = recordHand(this.sessionStats, {
				delta,
				potWon: humanWon,
				handKey: humanHand?.key ?? null,
			});
			saveSessionStats(this.sessionStats);
			this.ui.renderSessionStats(this.sessionStats);
		}

		// Showdown hands for the recap; a walkover shows only who took it.
		const reveals: RecapReveal[] = showdown
			? this.players
					.filter((player) => !player.folded)
					.map((player) => ({
						playerId: player.id,
						cards: player.hand,
						handKey: readHand(player.hand, this.communityCards)?.key ?? null,
						won: contestedAward(player.id),
					}))
			: headliners.map((player) => ({
					playerId: player.id,
					cards: [],
					handKey: null,
					won: contestedAward(player.id),
				}));
		const recap = this.recap.finish({ reveals, showdown, delta: involved ? delta : null });
		if (recap) this.ui.renderHandRecap(recap, this.recapSeats());

		if (involved && delta > 0) {
			const humanKey = featured === human ? featuredHand?.key : undefined;
			const big =
				humanWon >= 20 * this.handBigBlind ||
				(humanKey !== undefined && HAND_RANKINGS[humanKey] >= HAND_RANKINGS.FLUSH);
			this.sound.play(big ? 'bigWin' : 'win');
		} else if (involved && delta < 0 && !human.folded) {
			this.sound.play('lose');
		}
	}

	/**
	 * Presentation tiers for a hand everyone else folded: the pot's real
	 * contribution tiers, all won by `winner`, so an uncalled raise reads as
	 * returned rather than won. The chip award is still the whole pot.
	 */
	private walkoverTiers(winner: Player): TierResult[] {
		const tiers = calculateSidePots(this.players).map((pot) => ({
			amount: pot.amount,
			winners: [winner],
			uncontested: pot.contributorCount === 1,
		}));
		return tiers.length > 0 ? tiers : [{ amount: this.pot, winners: [winner], uncontested: false }];
	}

	/**
	 * Chips actually won in a walkover: the contested tiers, or the whole pot
	 * when every tier is a lone bettor's return (matching the banner, which
	 * falls back to showing the return rather than an empty result).
	 */
	private walkoverWinnings(tiers: TierResult[]): number {
		const contested = tiers
			.filter((tier) => !tier.uncontested)
			.reduce((sum, tier) => sum + tier.amount, 0);
		return contested > 0 ? contested : this.pot;
	}

	/** End-of-hand pause: hold the result for the player, or auto-deal if they opted in. */
	private finishHand(): void {
		this.handInProgress = false;
		// A fold settles mid-hand, so tell the table now that the hand is over.
		// Otherwise the settlement is still running and reports once it lands.
		if (!this.playsLocally && !this.settlementGate.isBlocked) this.dispatchHandSettled();
		this.settleTournamentOutcome();
		if (this.autoDealEnabled) this.scheduleAutoDeal(AUTO_DEAL_DELAY_MS);
		this.updateActionButtons();
	}

	/**
	 * End the tournament when a hand leaves the human busted or a single seat
	 * holding every chip, and report the human's place exactly once. Place
	 * math uses start-of-hand stacks so simultaneous busts with larger stacks
	 * finish ahead of the human; after this, every deal path stays blocked.
	 */
	private settleTournamentOutcome(): void {
		if (this.mode !== 'sng' || this.finishedPlace !== null) return;
		const humanChips = this.players[0].chips;
		const fundedSeats = this.players.filter((player) => player.chips > 0).length;
		if (humanChips > 0 && fundedSeats > 1) return;
		const place =
			humanChips > 0
				? 1
				: humanPlace(
						fundedSeats,
						this.handStartStacks.get(0) ?? 0,
						this.players
							.filter(
								(player) =>
									player.id !== 0 &&
									player.chips === 0 &&
									(this.handStartStacks.get(player.id) ?? 0) > 0,
							)
							.map((player) => this.handStartStacks.get(player.id) ?? 0),
					);
		this.finishedPlace = place;
		// Localized terminal status; the renderer shows the plain-link panel.
		this.updateGameStatus(this.t('tournamentFinished', { place: placeLabel(this.locale, place) }));
		this.ui.showTournamentTerminal(place);
	}

	/** Celebrate when a new street improves the human to two pair or better. */
	private announceImprovement(): void {
		const human = this.players[0];
		if (human.folded) return;
		const readout = readHand(human.hand, this.communityCards);
		if (!readout || !readout.usesHoleCards) return;
		const rank = HAND_RANKINGS[readout.key];
		if (rank >= HAND_RANKINGS.TWO_PAIR && rank > this.lastAnnouncedRank) {
			this.ui.showCallout(readout.key);
			this.sound.play('callout');
		}
		this.lastAnnouncedRank = Math.max(this.lastAnnouncedRank, rank);
	}

	private clearTimeoutRef(id: ReturnType<typeof setTimeout> | null): null {
		if (id !== null) clearTimeout(id);
		return null;
	}

	private cancelPendingAutoDeal(): void {
		this.autoDealToken += 1;
		this.autoDealTimeoutId = this.clearTimeoutRef(this.autoDealTimeoutId);
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
			if (turnTransitionToken !== this.turnTransitionToken) return;
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

	private scheduleAutoDeal(delayMs: number): void {
		this.cancelPendingAutoDeal();
		// A finished tournament never queues another hand.
		if (this.finishedPlace !== null) return;
		const autoDealToken = this.autoDealToken;
		this.autoDealTimeoutId = setTimeout(() => {
			if (autoDealToken !== this.autoDealToken) {
				return;
			}
			this.autoDealTimeoutId = null;
			void this.dealNewHand();
		}, delayMs);
	}

	// Check LLM configuration once on page load.
	private async checkLlmConfigOnLoad() {
		if (this.playsLocally) {
			return;
		}

		const settings = this.settingsManager.getSettings();
		if (!settings.useLLMAI) {
			return;
		}

		const llmSettings = await this.getLLMSettings();
		if (!llmSettings) {
			// Inform via status and show the overlay card
			this.updateGameStatus(this.t('errorLlmNoKey'));
			const overlay = document.getElementById('llm-overlay');
			if (overlay) {
				overlay.classList.remove('hidden');
			}
		}
	}

	private getSettlementRecoveryControls(): {
		container: HTMLElement | null;
		retry: HTMLButtonElement | null;
		reset: HTMLButtonElement | null;
	} {
		return ensureSettlementRecoveryControls({
			attachTo: null,
		});
	}

	private ensureSettlementRecoveryControls(): void {
		ensureSettlementRecoveryControls({
			containerClass: 'hidden mt-2 flex flex-wrap justify-center gap-2',
			retryClass: 'deco-btn deco-btn-outline',
			retryLabel: this.t('retrySettlement'),
			resetClass: 'deco-btn deco-btn-outline',
			resetLabel: this.t('resetRound'),
			attachTo: document.getElementById('game-status')?.parentElement ?? null,
		});
	}

	private dispatchEarnedAchievements(achievements?: Array<{ id: string; icon: string }>): void {
		if (!achievements || achievements.length === 0) return;
		if (
			typeof window === 'undefined' ||
			typeof window.dispatchEvent !== 'function' ||
			typeof CustomEvent !== 'function'
		) {
			return;
		}
		window.dispatchEvent(new CustomEvent('achievement-earned', { detail: { achievements } }));
	}

	private dispatchHandSettled(): void {
		if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
		window.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
	}

	/**
	 * Adopt an account balance that changed outside a hand (a mission claimed
	 * at the table). Mid-hand or mid-settlement it is skipped and returns
	 * false, so the caller can offer the account balance again once the hand
	 * has settled.
	 */
	public adoptAccountBalance(balance: number): boolean {
		if (!Number.isSafeInteger(balance) || balance < 0) return false;
		if (this.playsLocally || this.handInProgress || this.settlementGate.pending) return false;
		// The server just reported the account, so play can start even if the
		// balance was unavailable when the page loaded.
		this.hasServerSyncedBalance = true;
		this.serverSyncedBalance = balance;
		this.players[0] = { ...this.players[0], chips: balance };
		this.ui.updateUI(this.pot, this.players[0]);
		this.updateActionButtons();
		return true;
	}

	private showSettlementRecovery(message: string): void {
		this.updateGameStatus(message);
		const controls = this.getSettlementRecoveryControls();
		controls.container?.classList.remove('hidden');
		controls.retry?.classList.remove('hidden');
		controls.reset?.classList.remove('hidden');
	}

	private hideSettlementRecovery(): void {
		const controls = this.getSettlementRecoveryControls();
		controls.container?.classList.add('hidden');
		controls.retry?.classList.add('hidden');
		controls.reset?.classList.add('hidden');
	}

	private adoptSettlementResult(result: SettleRoundResult): void {
		this.serverSyncedBalance = result.balance;
		this.players[0] = { ...this.players[0], chips: result.balance };
		this.humanChipsBefore = 0;
		this.hideSettlementRecovery();
		if (result.newAchievements && result.newAchievements.length > 0) {
			this.dispatchEarnedAchievements(result.newAchievements);
		}
		// After a fold the hand plays on; finishHand reports it once it ends.
		if (!this.handInProgress) this.dispatchHandSettled();
		this.ui.updateUI(this.pot, this.players[0]);
		if (this.autoDealEnabled && !this.handInProgress && this.autoDealTimeoutId === null) {
			this.scheduleAutoDeal(AUTO_DEAL_DELAY_MS);
		}
		this.updateActionButtons();
	}

	private persistGuestBankroll(): void {
		if (!this.isGuestMode || this.mode !== 'cash') return;
		const persistedChips = Math.max(0, this.players[0]?.chips ?? this.serverSyncedBalance);
		persistGuestBankroll(PokerGame.GUEST_BANKROLL_GAME_KEY, this.clientUserId, persistedChips);
		this.serverSyncedBalance = persistedChips;
	}

	private settleHand(outcome: PokerSettlementOutcome = 'push'): void {
		// Freeze the hand-local result first: every call site reaches settleHand
		// exactly when the human's outcome becomes final (fold, walkover, or
		// showdown awards), before the async reconcile can replace the stack.
		if (this.handResultDelta === null && this.handStartChips > 0) {
			this.handResultDelta = this.players[0].chips - this.handStartChips;
		}
		if (this.playsLocally) {
			if (this.isGuestMode && this.mode === 'cash') {
				this.persistGuestBankroll();
			}
			this.humanChipsBefore = 0;
			return;
		}

		if (!this.hasServerSyncedBalance || this.humanChipsBefore <= 0) {
			console.warn('[WALLET_SETTLEMENT] Settlement requested without a hand baseline.');
			return;
		}

		const delta = this.players[0].chips - this.humanChipsBefore;
		const command = buildPokerSettlementCommand(delta, outcome);
		this.humanChipsBefore = 0;
		void this.settleAuthenticatedRound(command);
	}

	private async settleAuthenticatedRound(command: SettleRoundCommand): Promise<void> {
		try {
			const result = await this.settlementGate.settle(command);
			this.adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Poker settlement failed:', error);
			this.showSettlementRecovery(this.t('settlementFailed'));
		}
	}

	private wireSettlementRecoveryControls(): void {
		const controls = this.getSettlementRecoveryControls();
		controls.retry?.addEventListener('click', async () => {
			if (!this.settlementGate.pending) return;
			this.updateGameStatus(this.t('retryingSettlement'));
			try {
				const result = await this.settlementGate.retry();
				if (result) this.adoptSettlementResult(result);
			} catch (error) {
				console.error('[WALLET_SETTLEMENT] Poker settlement retry failed:', error);
				this.showSettlementRecovery(this.t('settlementRetryFailed'));
			}
		});
		controls.reset?.addEventListener('click', () => {
			this.settlementGate.reset();
			this.players[0] = { ...this.players[0], chips: this.serverSyncedBalance };
			this.humanChipsBefore = 0;
			this.hideSettlementRecovery();
			this.ui.updateUI(this.pot, this.players[0]);
			this.updateGameStatus(this.t('settlementReset'));
			this.updateActionButtons();
			// The settlement is closed without a result; let the table read the
			// account, or let finishHand do it if the hand is still being played.
			if (!this.handInProgress) this.dispatchHandSettled();
		});
	}

	private finalizeActiveHandBeforeDeal(): void {
		if (this.humanChipsBefore <= 0) {
			return;
		}

		this.settleHand('loss');
	}

	private buildAIConfig(personality: AIPersonality, difficulty: AIDifficulty): AIConfig {
		const base = createAIConfig(personality, difficulty);
		return this.aiRandom ? { ...base, random: this.aiRandom } : base;
	}

	private initPlayers() {
		const settings = this.settingsManager.getSettings();
		// Sit & Go seats all start at the fixed tournament stack; cash play
		// keeps its configured starting chips and the account/guest balance.
		const isSng = this.mode === 'sng';
		const humanStack = isSng ? SNG_START_STACK : this.getEffectiveServerBalance();
		const opponentStack = isSng ? SNG_START_STACK : settings.startingChips;
		this.players = [
			createPlayer(0, 'You', humanStack, false),
			createAIPlayer(1, 'Player 2', opponentStack),
			createAIPlayer(2, 'Player 3', opponentStack),
			...Array.from({ length: NUM_PLAYERS - 3 }, (_, i) =>
				createAIPlayer(i + 3, this.t('playerName', { number: String(i + 4) }), opponentStack),
			),
		];
		this.players[this.dealerIndex].isDealer = true;

		// Assign AI personalities and difficulties from settings
		this.aiConfigs.set(1, this.buildAIConfig(settings.aiPersonality1, settings.aiDifficulty1));
		this.aiConfigs.set(2, this.buildAIConfig(settings.aiPersonality2, settings.aiDifficulty2));

		for (const player of this.players.slice(3)) {
			this.aiConfigs.set(
				player.id,
				this.buildAIConfig(
					['tight-passive', 'loose-passive', 'tight-aggressive'][player.id - 3] as AIPersonality,
					DEFAULT_SETTINGS.aiDifficulty1,
				),
			);
		}

		// Update blinds from settings
		this.minimumBet = settings.bigBlind;
		this.lastRaiseAmount = settings.bigBlind;
		this.handSmallBlind = settings.smallBlind;
		this.handBigBlind = settings.bigBlind;
	}

	/**
	 * Get browser-local AI settings for automatic LLM opponents.
	 * Returns null only when local play (guest cash or Sit & Go) prevents
	 * access; otherwise returns the browser-local AI settings (which may be
	 * null if unconfigured).
	 */
	private async getLLMSettings(): Promise<AiSettings | null> {
		if (this.playsLocally) {
			return null;
		}

		return loadAiSettings();
	}

	public async dealNewHand() {
		this.cancelPendingAutoDeal();
		this.cancelPendingTurnTransitions();

		// Clear LLM cache for new hand
		clearLLMCache();

		const settings = this.settingsManager.getSettings();

		// If LLM-powered AI is enabled, ensure the user has a valid API key configured
		if (settings.useLLMAI && !this.playsLocally) {
			const llmSettings = await this.getLLMSettings();
			if (!llmSettings) {
				this.updateGameStatus(this.t('errorLlmNoKeyNewGame'));

				// Show non-intrusive overlay on the table instead of using a popup
				const overlay = document.getElementById('llm-overlay');
				if (overlay) {
					overlay.classList.remove('hidden');
				}

				return;
			}
		}

		if (!this.hasServerSyncedBalance) {
			this.updateGameStatus(this.t('errorBalanceUnavailable'));
			return;
		}

		if (!this.playsLocally && this.settlementGate.isBlocked) {
			this.showSettlementRecovery(this.t('settlementPending'));
			return;
		}

		this.finalizeActiveHandBeforeDeal();
		if (!this.playsLocally && this.settlementGate.isBlocked) {
			this.showSettlementRecovery(this.t('settlementPending'));
			return;
		}

		if (this.mode === 'sng') {
			// Tournament seats never rebuy or restore: play ends once the human
			// busts or a single seat holds every chip (finish UI is task 4).
			const fundedSeats = this.players.filter((p) => p.chips > 0).length;
			if (this.players[0].chips <= 0 || fundedSeats < 2) return;
		} else {
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
				this.updateGameStatus(this.t('statusChipReset'));
			}

			const eliminatedPlayers = this.players.filter((p) => p.chips === 0);
			if (eliminatedPlayers.length > 0) {
				const effectiveServerBalance = this.getEffectiveServerBalance();
				for (const player of eliminatedPlayers) {
					if (player.id === 0) {
						if (effectiveServerBalance <= 0) {
							this.updateGameStatus(this.t('statusGameOver'));
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
						this.players[player.id] = {
							...this.players[player.id],
							chips: settings.startingChips,
						};
						this.updateGameStatus(
							this.t('statusRebuys', {
								name: player.name,
								amount: formatChips(settings.startingChips, this.locale),
							}),
						);
					}
				}
			}
		}

		// Rotate the button to the next funded seat. Cash restored or rebought
		// every seat above, so this stays a plain clockwise rotation there;
		// tournament play skips busted seats and heads-up puts the button on
		// the small blind.
		const seats = nextFundedSeats(this.players, this.dealerIndex);
		this.dealerIndex = seats.buttonIndex;
		this.smallBlindIndex = seats.smallBlindIndex;
		this.bigBlindIndex = seats.bigBlindIndex;

		// Update dealer flag on players
		this.players = this.players.map((p) => ({ ...p, isDealer: false }));
		this.players[this.dealerIndex] = { ...this.players[this.dealerIndex], isDealer: true };

		// Reset deck and shuffle
		this.deck.reset();

		// Reset players for new hand (preserves chips from previous hands)
		this.players = this.players.map(resetPlayerForNewHand);
		// Busted tournament seats keep their seat but never act, post, or take
		// cards; their chips are gone for good.
		this.players = this.players.map((p) =>
			p.chips <= 0 ? { ...p, folded: true, hasActed: true } : p,
		);

		// Capture human chip count before blinds are posted (used for delta calculation at hand end)
		this.humanChipsBefore = this.players[0].chips;
		this.handStartChips = this.humanChipsBefore;
		this.handStartStacks = new Map(this.players.map((player) => [player.id, player.chips]));
		this.handResultDelta = null;
		this.handNumber += 1;
		this.handInProgress = true;
		this.ui.startHandHistory(this.handNumber);
		this.ui.clearHandResult();
		this.ui.clearSeatActions();

		// Deal 2 cards to each funded player
		for (let i = 0; i < this.players.length; i++) {
			if (this.players[i].chips <= 0) continue;
			const card1 = this.deck.drawCard();
			const card2 = this.deck.drawCard();
			this.players[i] = dealCardsToPlayer(this.players[i], [card1, card2]);
		}

		// Reset community cards
		this.communityCards = [];
		this.recap.start(this.handNumber, this.players[0].hand);
		this.sound.play('deal');
		const preflop = readHand(this.players[0].hand, []);
		this.lastAnnouncedRank = preflop ? HAND_RANKINGS[preflop.key] : -1;

		// Post blinds for this hand: the tournament derives them from the blind
		// level, cash keeps its configured blinds.
		const handBlinds =
			this.mode === 'sng'
				? SNG_BLINDS[levelFor(this.handNumber)]
				: { small: settings.smallBlind, big: settings.bigBlind };
		this.players[this.smallBlindIndex] = postBlind(
			this.players[this.smallBlindIndex],
			handBlinds.small,
		);
		this.players[this.bigBlindIndex] = postBlind(this.players[this.bigBlindIndex], handBlinds.big);

		// Set game state
		this.pot = calculatePot(this.players);
		this.gamePhase = 'preflop';
		this.bettingRound = 'preflop';
		this.minimumBet = handBlinds.big;
		this.lastRaiseAmount = handBlinds.big;
		this.handSmallBlind = handBlinds.small;
		this.handBigBlind = handBlinds.big;

		// Start with the first seat after the big blind that can still act; if
		// the blinds already resolved the round (every seat all-in) run the
		// board out on timers instead of handing anyone a turn.
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.bigBlindIndex);

		// Render UI
		this.ui.hideOpponentHands(); // Hide opponent cards for new hand
		this.ui.renderPlayerCards(this.players[0], this.communityCards);
		this.ui.renderCommunityCards(this.communityCards);
		this.ui.updateOpponentUI(this.players);
		this.ui.updateUI(this.pot, this.players[0]);
		this.aiRival.highlightSuggestedMove(null);
		this.hideRebuyButton();

		if (isBettingRoundComplete(this.players)) {
			this.scheduleTurnTransition(1000, () => this.nextPhase());
		} else if (this.currentPlayerIndex === 0) {
			this.updateGameStatus(
				this.t('statusYourTurnFull', {
					check: this.t('check'),
					call: this.t('call'),
					raise: this.t('raise'),
					fold: this.t('fold'),
				}),
			);
			this.updateActionButtons();
		} else {
			this.updateGameStatus(
				this.t('statusWaitingFor', { name: this.players[this.currentPlayerIndex].name }),
			);
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

		// A folded or all-in seat is never asked for a decision; reconcile and
		// advance so a dead seat can never place phantom bets.
		if (!canPlayerAct(currentPlayer)) {
			this.advanceTurn();
			return;
		}

		// Get AI config
		const aiConfig = this.aiConfigs.get(currentPlayer.id);
		if (!aiConfig) {
			// Fallback: just check/fold
			const highestBet = getHighestBet(this.players);
			const callAmount = getCallAmount(currentPlayer, highestBet);
			if (callAmount === 0) {
				this.updateGameStatus(this.t('statusPlayerChecks', { name: currentPlayer.name }));
				this.noteAction(currentPlayer.id, 'check');
			} else {
				this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
				this.updateGameStatus(this.t('statusPlayerFolds', { name: currentPlayer.name }));
				this.noteAction(currentPlayer.id, 'fold');
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

		if (settings.useLLMAI && !this.playsLocally) {
			// Try LLM-based AI with fallback to rule-based
			const llmSettings = await this.getLLMSettings();
			if (turnTransitionToken !== this.turnTransitionToken) return;
			decision = await makeLLMDecision(
				context,
				aiConfig.personality,
				llmSettings,
				aiConfig.difficulty,
				this.locale,
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
		if (decision.action === 'raise') {
			// A raise is also illegal when the stack cannot cover it (mirrors the
			// affordability check in the raise case below). Falling back to call
			// keeps the bet matched; with no bet pending a free check is always
			// legal, so the AI must never fold a hand it could see for free.
			const raiseToAdd = callAmount + (decision.amount || this.minimumBet);
			if (!this.hasRaiseRights(currentPlayer) || raiseToAdd > currentPlayer.chips) {
				decision = { ...decision, action: callAmount > 0 ? 'call' : 'check' };
			}
		}

		switch (decision.action) {
			case 'fold':
				this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
				this.updateGameStatus(this.t('statusPlayerFolds', { name: currentPlayer.name }));
				this.showDecision(currentPlayer.id, 'fold');
				break;

			case 'check':
				this.players[this.currentPlayerIndex] = { ...currentPlayer, hasActed: true };
				this.updateGameStatus(this.t('statusPlayerChecks', { name: currentPlayer.name }));
				this.showDecision(currentPlayer.id, 'check');
				break;

			case 'call':
				if (callAmount > 0) {
					// placeBet() clamps to remaining chips and marks the player all-in,
					// so short stacks can call all-in instead of being forced to fold.
					const actualCall = Math.min(callAmount, currentPlayer.chips);
					this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
					this.pot = calculatePot(this.players);
					const allInNote = this.players[this.currentPlayerIndex].isAllIn;
					this.updateGameStatus(
						this.t(allInNote ? 'statusPlayerCallsAllIn' : 'statusPlayerCalls', {
							name: currentPlayer.name,
							amount: formatChips(actualCall, this.locale),
						}),
					);
					this.showDecision(currentPlayer.id, 'call', actualCall);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// No bet to call - treat as a check
					this.players[this.currentPlayerIndex] = { ...currentPlayer, hasActed: true };
					this.updateGameStatus(this.t('statusPlayerChecks', { name: currentPlayer.name }));
					this.showDecision(currentPlayer.id, 'check');
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
					this.updateGameStatus(
						this.t('statusPlayerRaises', {
							name: currentPlayer.name,
							amount: formatChips(raiseAmount, this.locale),
						}),
					);
					this.showDecision(currentPlayer.id, 'raise', raiseAmount);
					this.ui.updateUI(this.pot, this.players[0]);
					this.ui.updateOpponentUI(this.players);
				} else {
					// Can't afford to raise, call instead (placeBet clamps to all-in)
					if (callAmount > 0) {
						const actualCall = Math.min(callAmount, currentPlayer.chips);
						this.players[this.currentPlayerIndex] = placeBet(currentPlayer, callAmount);
						this.pot = calculatePot(this.players);
						const allInNote = this.players[this.currentPlayerIndex].isAllIn;
						this.updateGameStatus(
							this.t(allInNote ? 'statusPlayerCallsAllIn' : 'statusPlayerCalls', {
								name: currentPlayer.name,
								amount: formatChips(actualCall, this.locale),
							}),
						);
						this.showDecision(currentPlayer.id, 'call', actualCall);
						this.ui.updateUI(this.pot, this.players[0]);
						this.ui.updateOpponentUI(this.players);
					} else {
						this.players[this.currentPlayerIndex] = foldPlayer(currentPlayer);
						this.updateGameStatus(this.t('statusPlayerFolds', { name: currentPlayer.name }));
						this.showDecision(currentPlayer.id, 'fold');
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
			this.isProcessingAction = true;
			this.updateActionButtons();
			// Move to next phase
			this.scheduleTurnTransition(1000, () => {
				this.isProcessingAction = false;
				this.nextPhase();
			});
			return;
		}

		// Move to next player
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.currentPlayerIndex);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus(this.t('statusYourTurn'));
			this.updateActionButtons();
		} else {
			this.updateGameStatus(
				this.t('statusWaitingFor', { name: this.players[this.currentPlayerIndex].name }),
			);
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
		this.ui.updateTableState(
			this.players,
			this.dealerIndex,
			this.currentPlayerIndex,
			this.bettingRound !== null,
		);
	}

	private updateActionButtons() {
		const human = this.players[0];
		const active = this.bettingRound !== null;
		const canAct =
			active &&
			this.currentPlayerIndex === 0 &&
			!this.isProcessingAction &&
			!human.folded &&
			!human.isAllIn;
		this.syncHumanTurn(canAct);
		const { call, canRaise } = this.getRaiseBounds();
		const enabled = {
			fold: canAct,
			check: canAct && call === 0,
			call: canAct && call > 0 && human.chips > 0,
			raise: canAct && canRaise,
		};
		for (const [action, allowed] of Object.entries(enabled)) {
			const button = document.getElementById(`btn-${action}`) as HTMLButtonElement | null;
			if (!button) continue;
			button.disabled = !allowed;
			button.hidden =
				!active || (action === 'call' && call === 0) || (action === 'check' && call > 0);
		}
		const callLabel = document.getElementById('call-amount');
		if (callLabel)
			callLabel.textContent = formatWholeNumber(Math.min(call, human.chips), this.locale);
		const deal = document.getElementById('btn-deal') as HTMLButtonElement | null;
		if (deal) {
			deal.hidden = active;
			deal.disabled =
				!this.hasServerSyncedBalance ||
				(!this.playsLocally && this.settlementGate.isBlocked) ||
				this.finishedPlace !== null;
			if (this.handNumber > 0) deal.textContent = this.t('nextHand');
			// The CSS countdown bar runs while an auto-deal is pending.
			deal.dataset.countdown = String(this.autoDealTimeoutId !== null && !active);
		}
		const recapButton = document.getElementById('btn-recap');
		if (recapButton) recapButton.hidden = active || this.recap.last === null;
		const autoDealLabel = document.getElementById('auto-deal-label');
		if (autoDealLabel) autoDealLabel.hidden = active;
		const autoDealToggle = document.getElementById('auto-deal-toggle') as HTMLInputElement | null;
		if (autoDealToggle) autoDealToggle.checked = this.autoDealEnabled;
		// Odds are drawn against the pot the human can actually win — a
		// short-stacked call contests only the tiers its chips cover.
		const callCap = Math.min(call, human.chips);
		this.ui.renderBetSummary(
			canAct,
			callCap,
			this.pot,
			contestablePot(this.players, human, callCap),
		);
		this.updateBetControls();
		this.ui.updateTableState(
			this.players,
			this.dealerIndex,
			this.currentPlayerIndex,
			active && !this.isProcessingAction,
		);
	}

	/**
	 * Builds the showdown status message from per-tier results. Distinguishes
	 * a genuine split-pot tie (multiple winners within one tier) from separate
	 * winners of different tiers (e.g. short stack wins main, covering player
	 * wins side), and reports each tier's amount instead of the total pot.
	 */
	private formatShowdownMessage(rawTierResults: TierResult[]): string {
		// Returned uncalled bets are not wins; keep them out of the status line.
		const tierResults = mergeTiersByWinners(rawTierResults.filter((tier) => !tier.uncontested));
		if (tierResults.length === 0) return this.t('statusShowdownComplete');
		if (tierResults.length === 1) {
			const { amount, winners } = tierResults[0];
			if (winners.length === 1) {
				return this.t(winners[0].id === 0 ? 'statusYouWin' : 'statusPlayerWins', {
					name: winners[0].name,
					amount: formatChips(amount, this.locale),
				});
			}
			const names = winners.map((w) => w.name).join(', ');
			return this.t('statusTieSplit', {
				names,
				amount: formatChips(amount, this.locale),
			});
		}
		// Multiple tiers: label main vs side pots and list each tier's winner(s).
		const parts = tierResults.map((tier, i) => {
			const label =
				i === 0 ? this.t('statusMainPot') : this.t('statusSidePot', { number: String(i) });
			const amount = formatChips(tier.amount, this.locale);
			if (tier.winners.length === 1) {
				return this.t(tier.winners[0].id === 0 ? 'statusTierYouWin' : 'statusTierWins', {
					label,
					name: tier.winners[0].name,
					amount,
				});
			}
			const names = tier.winners.map((w) => w.name).join(' & ');
			return this.t('statusTierSplit', { label, names, amount });
		});
		return parts.join(' | ');
	}

	private nextPhase() {
		// Check if only one player remains (everyone else folded)
		const activePlayers = getActivePlayers(this.players);
		if (activePlayers.length === 1) {
			this.bettingRound = null;
			const winner = activePlayers[0];
			const awards = new Map([[winner.id, this.pot]]);
			const tiers = this.walkoverTiers(winner);
			this.players[winner.id] = awardChips(winner, this.pot);
			this.updateGameStatus(
				this.t(winner.id === 0 ? 'statusYouWinWalkover' : 'statusPlayerWinsWalkover', {
					name: winner.name,
					amount: formatChips(this.walkoverWinnings(tiers), this.locale),
				}),
			);
			this.pot = 0;
			this.ui.updateUI(this.pot, this.players[0]);
			this.ui.updateOpponentUI(this.players);
			// Only sync when the human won (AI winning sole-survivor hands needs no sync)
			if (winner.id === 0) {
				this.settleHand('win');
			}
			this.presentHandResult(awards, tiers, false);
			this.finishHand();
			return;
		}

		// Reset current bets for new betting round
		this.players = this.players.map(resetCurrentBets);
		this.ui.clearSeatActions();

		if (this.gamePhase === 'preflop') {
			this.gamePhase = 'flop';
			this.bettingRound = 'flop';
			this.communityCards.push(this.deck.drawCard(), this.deck.drawCard(), this.deck.drawCard());
			this.recap.street('flop', this.communityCards.slice(0, 3));
			this.updateGameStatus(this.t('statusFlopRevealed'));
		} else if (this.gamePhase === 'flop') {
			this.gamePhase = 'turn';
			this.bettingRound = 'turn';
			this.communityCards.push(this.deck.drawCard());
			this.recap.street('turn', this.communityCards.slice(3));
			this.updateGameStatus(this.t('statusTurnRevealed'));
		} else if (this.gamePhase === 'turn') {
			this.gamePhase = 'river';
			this.bettingRound = 'river';
			this.communityCards.push(this.deck.drawCard());
			this.recap.street('river', this.communityCards.slice(4));
			this.updateGameStatus(this.t('statusRiverRevealed'));
		} else if (this.gamePhase === 'river') {
			this.gamePhase = 'showdown';
			this.bettingRound = null;
			// Determine winner(s) by comparing hands
			const activePlayers = getActivePlayers(this.players);
			if (activePlayers.length === 1) {
				// Only one player left - they win by default (folded on river)
				const winner = activePlayers[0];
				const tiers = this.walkoverTiers(winner);
				this.players[winner.id] = awardChips(winner, this.pot);
				this.updateGameStatus(
					this.t(winner.id === 0 ? 'statusYouWin' : 'statusPlayerWins', {
						name: winner.name,
						amount: formatChips(this.walkoverWinnings(tiers), this.locale),
					}),
				);
				if (winner.id === 0) {
					this.settleHand('win');
				}
				this.presentHandResult(new Map([[winner.id, this.pot]]), tiers, false);
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
					const outcome: PokerSettlementOutcome =
						humanDelta > 0 ? 'win' : humanDelta < 0 ? 'loss' : 'push';
					this.settleHand(outcome);
				}
				this.presentHandResult(awards, tierResults, true);
			}
			this.pot = 0;
			this.ui.updateUI(this.pot, this.players[0]);
			this.ui.updateOpponentUI(this.players);
			this.finishHand();
			return;
		}

		// Each street starts with a fresh minimum opening bet.
		this.minimumBet = this.handBigBlind;
		this.lastRaiseAmount = this.minimumBet;

		this.ui.renderCommunityCards(this.communityCards);
		this.ui.renderPlayerCards(this.players[0], this.communityCards);
		this.ui.updateUI(this.pot, this.players[0]);
		this.sound.play('flip');
		this.announceImprovement();

		// All-in runout: with fewer than two seats able to bet nobody gets a
		// turn (a lone actor cannot bet into an all-in), so the board runs out
		// on timers to the showdown.
		if (getPlayersWhoCanAct(this.players).length < 2) {
			this.scheduleTurnTransition(1000, () => this.nextPhase());
			return;
		}

		// Start new betting round from dealer
		this.currentPlayerIndex = getNextPlayerIndex(this.players, this.dealerIndex);

		if (this.currentPlayerIndex === 0) {
			this.updateGameStatus(this.t('statusYourTurn'));
			this.updateActionButtons();
		} else {
			this.updateGameStatus(
				this.t('statusWaitingFor', { name: this.players[this.currentPlayerIndex].name }),
			);
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
		if (!this.isGuestMode || this.mode !== 'cash') return;

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
				this.noteAction(0, 'fold');
				this.ui.updateUI(this.pot, this.players[0]);
				this.updateGameStatus(this.t('statusYouFolded'));
				// Sync immediately — human chip count is now locked in for this hand
				this.settleHand('loss');
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
				this.noteAction(0, 'check');
				this.updateGameStatus(this.t('statusYouChecked'));
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
				this.noteAction(0, 'call', actualCall);
				this.pot = calculatePot(this.players);
				this.ui.updateUI(this.pot, this.players[0]);
				const allInNote = this.players[0].isAllIn;
				this.updateGameStatus(
					this.t(allInNote ? 'statusYouCalledAllIn' : 'statusYouCalled', {
						amount: formatChips(actualCall, this.locale),
					}),
				);
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		document.getElementById('btn-raise')?.addEventListener('click', () => {
			const human = this.players[0];
			if (
				this.isProcessingAction ||
				this.currentPlayerIndex !== 0 ||
				this.bettingRound === null ||
				human.folded ||
				human.isAllIn
			)
				return;
			const raiseAmount = Number((document.getElementById('bet-slider') as HTMLInputElement).value);
			const { call, min, max, minimumRaise, canRaise } = this.getRaiseBounds();
			if (!canRaise || !Number.isInteger(raiseAmount) || raiseAmount < min || raiseAmount > max)
				return;
			this.isProcessingAction = true;
			this.updateActionButtons();
			try {
				this.players[0] = placeBet(human, call + raiseAmount);
				this.noteAction(0, 'raise', raiseAmount);
				// A short all-in does not reduce the next full raise's minimum.
				if (raiseAmount >= minimumRaise) {
					this.lastRaiseAmount = raiseAmount;
					this.minimumBet = raiseAmount;
				}
				this.pot = calculatePot(this.players);
				this.ui.updateUI(this.pot, this.players[0]);
				this.updateGameStatus(
					this.t('statusYouRaised', { amount: formatChips(raiseAmount, this.locale) }),
				);
			} finally {
				this.isProcessingAction = false;
			}
			this.advanceTurn();
		});

		const slider = document.getElementById('bet-slider') as HTMLInputElement | null;
		const input = document.getElementById('bet-input') as HTMLInputElement | null;
		slider?.addEventListener('input', () => {
			this.setRaiseAmount(Number(slider.value));
			this.updateActionButtons();
		});
		input?.addEventListener('input', () => {
			if (input.value !== '' && input.validity.valid) {
				this.setRaiseAmount(Number(input.value));
				this.updateActionButtons();
			} else {
				const raise = document.getElementById('btn-raise') as HTMLButtonElement | null;
				if (raise) raise.disabled = true;
			}
		});
		input?.addEventListener('change', () => {
			this.setRaiseAmount(Number(input.value));
			this.updateActionButtons();
		});
		document.querySelectorAll<HTMLButtonElement>('.quick-bet-chip').forEach((button) => {
			button.addEventListener('click', () => this.setRaiseAmount(Number(button.dataset.amount)));
		});
		const autoDealToggle = document.getElementById('auto-deal-toggle') as HTMLInputElement | null;
		autoDealToggle?.addEventListener('change', () => this.setAutoDeal(autoDealToggle.checked));
		document.getElementById('btn-sound')?.addEventListener('click', () => {
			this.sound.setMuted(!this.sound.isMuted());
			this.sound.play('check');
			this.renderToggles();
		});
		document
			.getElementById('btn-turn-timer')
			?.addEventListener('click', () => this.setTurnTimer(!this.turnTimerEnabled));
		document.getElementById('btn-recap')?.addEventListener('click', () => {
			(document.getElementById('recap-panel') as HTMLDialogElement | null)?.showModal?.();
		});
		this.renderToggles();
		// Browsers only start audio from a user gesture.
		const unlockAudio = () => this.sound.unlock();
		window.addEventListener('pointerdown', unlockAudio, { once: true });
		window.addEventListener('keydown', unlockAudio, { once: true });
		// Hold the countdown while the tab is in the background; restart it on return.
		document.addEventListener?.('visibilitychange', () => {
			if (document.visibilityState !== 'visible') this.stopTurnTimer();
			else if (this.humanTurnLive) this.startTurnTimer();
		});

		// Keyboard play: F fold, C check/call, R raise, Space/Enter next hand.
		window.addEventListener('keydown', (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				target?.closest?.('input, select, textarea, dialog, [contenteditable="true"]')
			)
				return;
			const key = event.key.toLowerCase();
			const press = (id: string) => {
				const button = document.getElementById(id) as HTMLButtonElement | null;
				if (!button || button.hidden || button.disabled) return false;
				button.click();
				return true;
			};
			let handled = false;
			if (key === 'f') handled = press('btn-fold');
			else if (key === 'c') handled = press('btn-check') || press('btn-call');
			else if (key === 'r') handled = press('btn-raise');
			else if ((key === ' ' || key === 'enter') && target?.tagName !== 'BUTTON')
				handled = press('btn-deal');
			if (handled) event.preventDefault();
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
				this.updateGameStatus(this.t('errorSettingsIncomplete'));
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
			const useLLMAI = this.playsLocally ? false : useLLMAIEl.checked;

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
			this.renderRivals();

			// Mark that chips should be reset on next deal
			this.pendingChipReset = true;

			// Update bet controls to reflect new minimum bet
			this.updateBetControls();

			// Notify user
			this.updateGameStatus(this.t('statusSettingsSaved'));

			// Hide settings panel
			(document.getElementById('settings-panel') as HTMLDialogElement | null)?.close();
		});

		// Reset settings
		document.getElementById('btn-reset-settings')?.addEventListener('click', () => {
			this.settingsManager.resetToDefaults();
			this.renderSettingsPanel();

			// Update AI configs to match reset defaults
			const defaults = this.settingsManager.getSettings();
			this.aiConfigs.set(1, this.buildAIConfig(defaults.aiPersonality1, defaults.aiDifficulty1));
			this.aiConfigs.set(2, this.buildAIConfig(defaults.aiPersonality2, defaults.aiDifficulty2));
			this.renderRivals();

			// Mark that chips should be reset on next deal
			this.pendingChipReset = true;

			// Update bet controls to reflect reset minimum bet
			this.updateBetControls();

			this.updateGameStatus(this.t('statusSettingsReset'));
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
			useLLMAICheckbox.checked = this.playsLocally ? false : settings.useLLMAI;
			useLLMAICheckbox.disabled = this.playsLocally;
			useLLMAICheckbox.title = this.playsLocally ? this.t('aiLlmTitleGuest') : '';
			const llmHelpText = useLLMAICheckbox.parentElement?.querySelector('.text-xs');
			if (llmHelpText) {
				llmHelpText.textContent = this.playsLocally
					? this.t('aiLlmHelpGuest')
					: this.t('aiLlmHelp');
			}
		}
	}

	private hasRaiseRights(player: Player): boolean {
		const minimumRaise = Math.max(this.handBigBlind, this.minimumBet);
		// Only a full increase since this player's last action reopens their betting.
		// Comparing commitments also handles cumulative short all-ins per player.
		return !player.hasActed || getCallAmount(player, getHighestBet(this.players)) >= minimumRaise;
	}

	private getRaiseBounds() {
		const human = this.players[0];
		const call = getCallAmount(human, getHighestBet(this.players));
		const minimumRaise = Math.max(this.handBigBlind, this.minimumBet);
		const available = Math.max(0, human.chips - call);
		// Below a full raise, only an all-in for the entire remaining stack is legal.
		const min = Math.min(minimumRaise, available);
		const max = Math.min(MAX_BET, available);
		return {
			call,
			minimumRaise,
			min,
			max,
			canRaise: max > 0 && max >= min && this.hasRaiseRights(human),
		};
	}

	private setRaiseAmount(amount: number) {
		const slider = document.getElementById('bet-slider') as HTMLInputElement | null;
		if (!slider || !Number.isFinite(amount)) return;
		const value = Math.max(Number(slider.min), Math.min(Number(slider.max), Math.round(amount)));
		slider.value = String(value);
		const input = document.getElementById('bet-input') as HTMLInputElement | null;
		if (input) input.value = String(value);
		const label = document.getElementById('bet-amount');
		if (label) label.textContent = formatWholeNumber(value, this.locale);
		document.querySelectorAll<HTMLElement>('.quick-bet-chip').forEach((button) => {
			button.setAttribute('aria-pressed', String(Number(button.dataset.amount) === value));
		});
	}

	private updateBetControls(reset = false) {
		const human = this.players[0];
		const { call, min, max, canRaise } = this.getRaiseBounds();
		const disabled = this.bettingRound === null || human.folded || human.isAllIn || !canRaise;
		const slider = document.getElementById('bet-slider') as HTMLInputElement | null;
		const input = document.getElementById('bet-input') as HTMLInputElement | null;
		for (const control of [slider, input]) {
			if (!control) continue;
			control.min = String(Math.min(min, max));
			control.max = String(max);
			control.step = '1';
			control.disabled = disabled;
		}
		// A raise amount is added on top of the call, so pot-sized presets are
		// measured against the pot after calling.
		const potAfterCall = this.pot + call;
		const presets = [
			Math.round(potAfterCall / 2),
			Math.round((potAfterCall * 2) / 3),
			potAfterCall,
			max,
		];
		document.querySelectorAll<HTMLButtonElement>('.quick-bet-chip').forEach((button, index) => {
			const amount = Math.min(max, Math.max(min, presets[index]));
			button.dataset.amount = String(amount);
			button.disabled = disabled;
			const label = button.querySelector('[data-preset-amount]');
			if (label) label.textContent = formatWholeNumber(amount, this.locale);
		});
		const blinds = document.getElementById('table-blinds');
		if (blinds)
			blinds.textContent = `${formatWholeNumber(this.handSmallBlind, this.locale)} / ${formatWholeNumber(this.handBigBlind, this.locale)}`;
		if (this.mode === 'sng') {
			this.ui.renderTournament({
				handNumber: this.handNumber,
				fundedSeats: this.players.filter((player) => player.chips > 0).length,
				place: this.finishedPlace,
			});
		}
		this.setRaiseAmount(reset ? this.handBigBlind * 2 : Number(slider?.value ?? min));
	}
}
