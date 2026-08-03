import { renderBlackjackDealer, renderBlackjackPlayerHands } from '../blackjack/presentation';
import { BLACKJACK_DAILY_V1_CONFIG } from './config';
import type {
	DailyChallengeActiveRoundV1,
	DailyChallengeAttemptPublicStateV1,
	DailyChallengeHistoryResponse,
	DailyChallengeLeaderboardResponse,
	DailyChallengePublicResponse,
} from './protocol';
import type { DailyChallengeReplayV1 } from './replay';

export type DailyChallengeMode = 'practice' | 'ranked';
export type DailyChallengeReplayScenario = 'practice-scenario' | 'exact-ranked-scenario';
export type DailyChallengeAction = 'hit' | 'stand' | 'double-down' | 'split';

export interface DailyChallengeRendererHandlers {
	onSelectMode(mode: DailyChallengeMode): void;
	onStartRanked(): void;
	onStartRound(wager: number): void;
	onAction(action: DailyChallengeAction): void;
	onForfeit(): void;
	onRestartPractice(): void;
	onSelectReplayScenario(scenario: DailyChallengeReplayScenario): void;
}

export interface DailyChallengeRenderer {
	bind(handlers: DailyChallengeRendererHandlers): void;
	renderChallenge(challenge: DailyChallengePublicResponse): void;
	renderAttempt(attempt: DailyChallengeAttemptPublicStateV1 | null): void;
	renderLeaderboard(leaderboard: DailyChallengeLeaderboardResponse): void;
	renderHistory(history: DailyChallengeHistoryResponse): void;
	renderLocalReplay(replay: DailyChallengeReplayV1 | null): void;
	setPending(pending: boolean): void;
	renderError(message: string): void;
}

const CURRENCY = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 0,
	maximumFractionDigits: 0,
});

function formatCurrency(value: number): string {
	return CURRENCY.format(value);
}

function formatPercentile(value: number): string {
	const suffix =
		value % 100 >= 11 && value % 100 <= 13
			? 'th'
			: value % 10 === 1
				? 'st'
				: value % 10 === 2
					? 'nd'
					: value % 10 === 3
						? 'rd'
						: 'th';
	return `${value}${suffix}`;
}

function terminalReasonLabel(reason: string): string {
	switch (reason) {
		case 'completed':
			return 'Completed';
		case 'bankroll-below-minimum':
			return 'Bankroll below minimum';
		case 'forfeited':
			return 'Forfeited';
		case 'expired':
			return 'Expired';
		default:
			return reason;
	}
}

function roundProgressLabel(roundsCompleted: number): string {
	const roundCount = BLACKJACK_DAILY_V1_CONFIG.roundCount;
	const current = Math.min(roundsCompleted + 1, roundCount);
	return `Round ${current} of ${roundCount}`;
}

function formatCloseTime(rankedEntryClosesAt: number): string {
	const date = new Date(rankedEntryClosesAt * 1000);
	const time = date.toISOString().slice(11, 16);
	return `Ranked entry closes at ${time} UTC.`;
}

type ViewState = 'none' | 'ranked' | 'replay';

const ACTION_ORDER: readonly DailyChallengeAction[] = ['hit', 'stand', 'double-down', 'split'];

export function createDailyChallengeRenderer(root: HTMLElement): DailyChallengeRenderer {
	const get = (testId: string): HTMLElement => {
		const element = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
		if (!element) throw new Error(`missing daily challenge element ${testId}`);
		return element;
	};

	const closeEl = get('daily-challenge-close');
	const practiceModeEl = get('daily-challenge-mode-practice');
	const rankedModeEl = get('daily-challenge-mode-ranked');
	const signInCtaEl = get('daily-challenge-sign-in-cta');
	const practiceNoticesEl = get('daily-challenge-practice-notices');
	const practiceDifferentEl = get('daily-challenge-practice-different');
	const sharedSeedNoticeEl = get('daily-challenge-shared-seed-notice');
	const rankedNoticesEl = get('daily-challenge-ranked-notices');
	const onceWarningEl = get('daily-challenge-once-warning');
	const controlsEl = get('daily-challenge-controls');
	const bankrollEl = get('daily-challenge-bankroll');
	const committedWagerEl = get('daily-challenge-committed-wager');
	const roundProgressEl = get('daily-challenge-round-progress');
	const dealerValueEl = get('daily-challenge-dealer-value');
	const dealerHandEl = get('daily-challenge-dealer-hand');
	const playerHandsEl = get('daily-challenge-player-hands');
	const statusEl = get('daily-challenge-status');
	const wagerEl = get('daily-challenge-wager') as HTMLInputElement;
	const startRankedEl = get('daily-challenge-start-ranked') as HTMLButtonElement;
	const startRoundEl = get('daily-challenge-start-round') as HTMLButtonElement;
	const actionEls: Record<DailyChallengeAction, HTMLButtonElement> = {
		hit: get('daily-challenge-action-hit') as HTMLButtonElement,
		stand: get('daily-challenge-action-stand') as HTMLButtonElement,
		'double-down': get('daily-challenge-action-double-down') as HTMLButtonElement,
		split: get('daily-challenge-action-split') as HTMLButtonElement,
	};
	const forfeitEl = get('daily-challenge-forfeit') as HTMLButtonElement;
	const forfeitConfirmEl = get('daily-challenge-forfeit-confirm') as HTMLButtonElement;
	const forfeitCancelEl = get('daily-challenge-forfeit-cancel') as HTMLButtonElement;
	const restartPracticeEl = get('daily-challenge-restart-practice') as HTMLButtonElement;
	const replayPracticeEl = get('daily-challenge-replay-scenario-practice') as HTMLButtonElement;
	const replayExactRankedEl = get(
		'daily-challenge-replay-scenario-exact-ranked',
	) as HTMLButtonElement;
	const receiptEl = get('daily-challenge-receipt');
	const receiptEligibilityEl = get('daily-challenge-receipt-eligibility');
	const receiptBankrollEl = get('daily-challenge-receipt-bankroll');
	const receiptRoundsEl = get('daily-challenge-receipt-rounds');
	const receiptRankEl = get('daily-challenge-rank');
	const receiptPercentileEl = get('daily-challenge-percentile');
	const leaderboardRowsEl = get('daily-challenge-leaderboard-rows');
	const currentStandingEl = get('daily-challenge-current-standing');
	const historyRowsEl = get('daily-challenge-history-rows');

	let handlers: DailyChallengeRendererHandlers | null = null;
	let mode: DailyChallengeMode | null = null;
	let pending = false;
	let view: ViewState = 'none';
	let challenge: DailyChallengePublicResponse | null = null;
	let rankedAttempt: DailyChallengeAttemptPublicStateV1 | null = null;
	let localReplay: DailyChallengeReplayV1 | null = null;
	let forfeitConfirmVisible = false;
	let previousRankedRoundActive = false;

	const hasActiveRound = (): boolean => {
		if (view === 'replay') return localReplay !== null && localReplay.activeRoundPublic !== null;
		return rankedAttempt !== null && rankedAttempt.activeRound !== null;
	};

	const availableActions = (): readonly DailyChallengeAction[] => {
		if (view === 'replay') {
			return (localReplay?.activeRoundPublic?.availableActions ??
				[]) as readonly DailyChallengeAction[];
		}
		return (rankedAttempt?.activeRound?.availableActions ?? []) as readonly DailyChallengeAction[];
	};

	const syncControls = (): void => {
		const activeRound = hasActiveRound();
		const actions = availableActions();
		wagerEl.disabled = pending || activeRound;
		startRankedEl.disabled = pending || (view === 'ranked' && rankedAttempt?.status === 'active');
		startRoundEl.disabled = pending || activeRound;
		(actionEls.hit as HTMLButtonElement).disabled = pending || !actions.includes('hit');
		(actionEls.stand as HTMLButtonElement).disabled = pending || !actions.includes('stand');
		(actionEls['double-down'] as HTMLButtonElement).disabled =
			pending || !actions.includes('double-down');
		(actionEls.split as HTMLButtonElement).disabled = pending || !actions.includes('split');
		forfeitEl.disabled = pending;
		restartPracticeEl.disabled = pending;
		replayPracticeEl.disabled = pending;
		replayExactRankedEl.disabled =
			pending || challenge === null || challenge.revealedRankedSeed === null;
	};

	const syncHidden = (): void => {
		practiceNoticesEl.hidden = mode !== 'practice';
		rankedNoticesEl.hidden = mode !== 'ranked';
		forfeitEl.hidden =
			view === 'ranked' ? rankedAttempt?.activeRound === null : localReplay?.status !== 'active';
		forfeitConfirmEl.hidden = !forfeitConfirmVisible;
		forfeitCancelEl.hidden = !forfeitConfirmVisible;
		restartPracticeEl.hidden = false;
		// Hide the start-ranked button for guests and when a ranked attempt is already active.
		startRankedEl.hidden =
			root.dataset.userId === undefined ||
			root.dataset.userId === 'guest' ||
			rankedAttempt?.status === 'active';
	};

	const renderActiveRound = (round: DailyChallengeActiveRoundV1): void => {
		renderBlackjackDealer(document, dealerHandEl, dealerValueEl, round.dealer, {
			testIdPrefix: 'daily-challenge',
		});
		renderBlackjackPlayerHands(document, playerHandsEl, round.playerHands, round.activeHandIndex, {
			testIdPrefix: 'daily-challenge',
			formatWager: formatCurrency,
		});
	};

	const clearHands = (): void => {
		dealerHandEl.replaceChildren();
		dealerValueEl.textContent = '';
		playerHandsEl.replaceChildren();
	};

	const renderAttempt = (attempt: DailyChallengeAttemptPublicStateV1 | null): void => {
		view = 'ranked';
		rankedAttempt = attempt;
		forfeitConfirmVisible = false;
		controlsEl.hidden = false;
		receiptEl.hidden = true;
		clearHands();
		syncHidden();
		syncControls();

		if (attempt === null) {
			bankrollEl.textContent = '\u2014';
			committedWagerEl.textContent = '\u2014';
			roundProgressEl.textContent = '';
			statusEl.textContent = 'Start your ranked attempt to begin.';
			previousRankedRoundActive = false;
			return;
		}

		bankrollEl.textContent = formatCurrency(attempt.availableBankroll);
		const activeRound = attempt.activeRound;
		committedWagerEl.textContent = activeRound
			? formatCurrency(activeRound.committedWager)
			: '\u2014';
		roundProgressEl.textContent = roundProgressLabel(attempt.roundsCompleted);

		if (activeRound) {
			renderActiveRound(activeRound);
			statusEl.textContent = '';
			if (!previousRankedRoundActive) {
				const firstAction = ACTION_ORDER.find((action) =>
					attempt.activeRound?.availableActions.includes(action),
				);
				if (firstAction) actionEls[firstAction].focus();
			}
			previousRankedRoundActive = true;
		} else {
			previousRankedRoundActive = false;
		}

		if (attempt.status !== 'active' && attempt.receipt) {
			const receipt = attempt.receipt;
			receiptEl.hidden = false;
			receiptEligibilityEl.textContent = receipt.eligible
				? 'Eligible for ranking'
				: 'Not eligible for ranking';
			receiptBankrollEl.textContent = formatCurrency(receipt.endingBankroll);
			receiptRoundsEl.textContent = `${receipt.roundsCompleted} of ${BLACKJACK_DAILY_V1_CONFIG.roundCount} rounds`;
			receiptRankEl.hidden = attempt.rank === null;
			receiptRankEl.textContent = attempt.rank === null ? '' : `#${attempt.rank}`;
			receiptPercentileEl.hidden = attempt.percentile === null;
			receiptPercentileEl.textContent =
				attempt.percentile === null ? '' : `${formatPercentile(attempt.percentile)} percentile`;
		}
	};

	const renderLocalReplay = (replay: DailyChallengeReplayV1 | null): void => {
		view = 'replay';
		localReplay = replay;
		forfeitConfirmVisible = false;
		controlsEl.hidden = false;
		receiptEl.hidden = true;
		clearHands();
		syncHidden();
		syncControls();

		if (replay === null) {
			bankrollEl.textContent = '\u2014';
			committedWagerEl.textContent = '\u2014';
			roundProgressEl.textContent = '';
			statusEl.textContent = 'Start practice to play the local scenario.';
			return;
		}

		bankrollEl.textContent = formatCurrency(replay.availableBankroll);
		const activeRoundPublic = replay.activeRoundPublic;
		committedWagerEl.textContent = activeRoundPublic
			? formatCurrency(activeRoundPublic.committedWager)
			: '\u2014';
		roundProgressEl.textContent = roundProgressLabel(replay.roundsCompleted);

		if (activeRoundPublic) {
			renderActiveRound(activeRoundPublic);
		}

		if (replay.status === 'completed') {
			statusEl.textContent = 'Run complete';
		} else if (replay.status === 'forfeited') {
			statusEl.textContent = 'Run forfeited';
		} else {
			statusEl.textContent = '';
		}
	};

	const selectMode = (next: DailyChallengeMode): void => {
		mode = next;
		syncHidden();
		handlers?.onSelectMode(next);
	};

	const startRound = (): void => {
		const parsed = Number(wagerEl.value);
		if (!Number.isNaN(parsed)) handlers?.onStartRound(Math.trunc(parsed));
	};

	return {
		bind(nextHandlers: DailyChallengeRendererHandlers): void {
			handlers = nextHandlers;
			practiceModeEl.addEventListener('click', () => selectMode('practice'));
			rankedModeEl.addEventListener('click', () => selectMode('ranked'));
			startRankedEl.addEventListener('click', () => handlers?.onStartRanked());
			startRoundEl.addEventListener('click', startRound);
			actionEls.hit.addEventListener('click', () => handlers?.onAction('hit'));
			actionEls.stand.addEventListener('click', () => handlers?.onAction('stand'));
			actionEls['double-down'].addEventListener('click', () => handlers?.onAction('double-down'));
			actionEls.split.addEventListener('click', () => handlers?.onAction('split'));
			forfeitEl.addEventListener('click', () => {
				forfeitConfirmVisible = true;
				syncHidden();
			});
			forfeitCancelEl.addEventListener('click', () => {
				forfeitConfirmVisible = false;
				syncHidden();
			});
			forfeitConfirmEl.addEventListener('click', () => {
				forfeitConfirmVisible = false;
				syncHidden();
				handlers?.onForfeit();
			});
			restartPracticeEl.addEventListener('click', () => handlers?.onRestartPractice());
			replayPracticeEl.addEventListener('click', () =>
				handlers?.onSelectReplayScenario('practice-scenario'),
			);
			replayExactRankedEl.addEventListener('click', () =>
				handlers?.onSelectReplayScenario('exact-ranked-scenario'),
			);
		},

		renderChallenge(nextChallenge: DailyChallengePublicResponse): void {
			challenge = nextChallenge;
			const authenticated = root.dataset.userId !== undefined && root.dataset.userId !== 'guest';
			practiceModeEl.hidden = false;
			rankedModeEl.hidden = !authenticated;
			signInCtaEl.hidden = authenticated;
			controlsEl.hidden = false;
			closeEl.textContent = formatCloseTime(nextChallenge.rankedEntryClosesAt);
			practiceDifferentEl.textContent =
				'Practice uses a different scenario from today\u2019s ranked attempt.';
			sharedSeedNoticeEl.textContent =
				'Shared daily scenarios are not resistant to player-to-player spoilers.';
			onceWarningEl.textContent = 'You get one ranked attempt per daily challenge.';
			syncHidden();
			syncControls();
		},

		renderAttempt,

		renderLeaderboard(leaderboard: DailyChallengeLeaderboardResponse): void {
			leaderboardRowsEl.replaceChildren(
				...leaderboard.entries.map((entry) => {
					const row = document.createElement('li');
					row.dataset.testid = 'daily-challenge-leaderboard-row';
					if (entry.isCurrentUser) {
						row.dataset.isCurrentUser = 'true';
					}
					row.textContent = `#${entry.rank} ${entry.playerName} ${formatCurrency(entry.endingBankroll)}${entry.isCurrentUser ? ' (you)' : ''}`;
					return row;
				}),
			);
			currentStandingEl.hidden = leaderboard.currentUser === null;
			if (leaderboard.currentUser) {
				currentStandingEl.textContent = `#${leaderboard.currentUser.rank} \u00b7 ${leaderboard.currentUser.percentile}%`;
			}
		},

		renderHistory(history: DailyChallengeHistoryResponse): void {
			historyRowsEl.replaceChildren(
				...history.entries.map((entry) => {
					const row = document.createElement('li');
					row.dataset.testid = 'daily-challenge-history-row';
					if (entry.userResult) {
						row.dataset.eligible = String(entry.userResult.eligible);
					}
					const link = document.createElement('a');
					link.dataset.testid = 'daily-challenge-history-link';
					link.href = `/games/daily-challenge/${entry.periodKey}`;
					const parts = [
						entry.periodKey,
						entry.topEndingBankroll !== null
							? `Top ${formatCurrency(entry.topEndingBankroll)}`
							: 'No scores yet',
						`${entry.participantCount} ${entry.participantCount === 1 ? 'player' : 'players'}`,
					];
					if (entry.userResult) {
						const { userResult } = entry;
						parts.push(
							`You: ${formatCurrency(userResult.endingBankroll)} \u00b7 ${userResult.roundsCompleted} rounds \u00b7 ${terminalReasonLabel(userResult.terminalReason)}`,
						);
					} else {
						parts.push('Not played');
					}
					link.textContent = parts.join(' \u00b7 ');
					row.appendChild(link);
					return row;
				}),
			);
		},

		renderLocalReplay,

		setPending(nextPending: boolean): void {
			pending = nextPending;
			syncControls();
		},

		renderError(message: string): void {
			statusEl.textContent = message;
		},
	};
}
