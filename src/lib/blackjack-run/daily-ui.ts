import { renderBlackjackDealer, renderBlackjackPlayerHands } from '../blackjack/presentation';
import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import {
	createBlackjackRunClient,
	type BlackjackRunClient,
	type BlackjackRunClientCommand,
} from './client';
import { DAILY_RUN_CONFIG, replayDailyRun, type DailyRunReplay } from './daily';
import {
	BlackjackRunError,
	periodKeySchema,
	type BlackjackAction,
	type BlackjackRunCommand,
	type BlackjackRunPublicState,
} from './protocol';

/**
 * Daily Challenge DOM behavior for the unified Blackjack Run APIs.
 *
 * Consolidates the Daily DOM behavior onto the unified run surfaces:
 *
 * - Practice is fully browser-local: a `crypto.getRandomValues` seed, a local
 *   sequenced command array, and `replayDailyRun` drive the view. No API
 *   POST, no localStorage, no practice run id; a restart mints a fresh seed
 *   and an empty command log. Practice is available to guests and authed
 *   users alike.
 * - Ranked is the single server-backed daily attempt per period, driven
 *   exclusively through the shared Task 6 run client (`startDaily`,
 *   `command`, `loadCurrent('daily')`).
 * - Guests get the Task 5 surface: `GET /api/blackjack-daily/current` answers
 *   a definitive 404 `RUN_NOT_FOUND`, and the page renders Practice plus the
 *   sign-in CTA.
 *
 * Exact-ranked replay, historical replay, the seven-day history, and every
 * verifiable-receipt surface from the pre-consolidation page are deliberately
 * absent.
 */

export type DailyRunState = Extract<BlackjackRunPublicState, { mode: 'daily' }>;
export type DailyRunMode = 'practice' | 'ranked';

export const DAILY_CURRENT_PATH = '/api/blackjack-daily/current';
export const DAILY_LEADERBOARD_PATH_PREFIX = '/api/blackjack-daily';

const DEFAULT_TIMEOUT_MS = 10_000;
const RUN_NOT_FOUND = 'RUN_NOT_FOUND';

const ACTIONS: readonly BlackjackAction[] = ['hit', 'stand', 'double-down', 'split'];

const PRACTICE_READY_STATUS = 'Start a round to begin practice.';
const PRACTICE_COMPLETE_STATUS = 'Practice complete.';
const PRACTICE_FORFEITED_STATUS = 'Practice forfeited.';
const PRACTICE_OVER_STATUS = 'Practice is over — restart to play a new scenario.';
const RANKED_IDLE_STATUS = 'Start your ranked attempt to begin.';

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

function roundProgressLabel(roundsCompleted: number): string {
	const roundCount = DAILY_RUN_CONFIG.roundCount;
	return `Round ${Math.min(roundsCompleted + 1, roundCount)} of ${roundCount}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Daily challenge request failed';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(payload: unknown): string | null {
	return isPlainObject(payload) && typeof payload.error === 'string' ? payload.error : null;
}

// --- leaderboard view model ---

export interface DailyLeaderboardEntryView {
	readonly rank: number;
	readonly playerName: string;
	readonly endingBankroll: number;
	readonly roundsCompleted: number;
}

export interface DailyCurrentUserStandingView {
	readonly rank: number;
	readonly totalEligible: number;
	readonly percentile: number;
}

export interface DailyLeaderboardView {
	readonly entries: readonly DailyLeaderboardEntryView[];
	readonly currentUser: DailyCurrentUserStandingView | null;
}

function parseSafeInteger(
	container: Record<string, unknown>,
	key: string,
	minimum: number,
): number {
	const value = container[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
		throw new TypeError(`Daily leaderboard field "${key}" is invalid`);
	}
	return value;
}

export function parseDailyLeaderboardView(payload: unknown): DailyLeaderboardView {
	if (!isPlainObject(payload) || !Array.isArray(payload.entries)) {
		throw new TypeError('Daily leaderboard response was malformed');
	}
	const entries = payload.entries.map((raw): DailyLeaderboardEntryView => {
		if (!isPlainObject(raw) || typeof raw.playerName !== 'string') {
			throw new TypeError('Daily leaderboard entry was malformed');
		}
		return {
			rank: parseSafeInteger(raw, 'rank', 1),
			playerName: raw.playerName,
			endingBankroll: parseSafeInteger(raw, 'dailyEndingBankroll', 0),
			roundsCompleted: parseSafeInteger(raw, 'dailyRoundsCompleted', 0),
		};
	});
	const rawStanding = payload.currentUser;
	if (rawStanding === null || rawStanding === undefined) {
		return { entries, currentUser: null };
	}
	if (!isPlainObject(rawStanding)) {
		throw new TypeError('Daily leaderboard current user was malformed');
	}
	const percentile = rawStanding.percentile;
	if (typeof percentile !== 'number' || !Number.isFinite(percentile)) {
		throw new TypeError('Daily leaderboard field "percentile" is invalid');
	}
	return {
		entries,
		currentUser: {
			rank: parseSafeInteger(rawStanding, 'rank', 1),
			totalEligible: parseSafeInteger(rawStanding, 'totalEligible', 1),
			percentile,
		},
	};
}

// --- renderer ---

export interface DailyRunRendererHandlers {
	onSelectMode(mode: DailyRunMode): void;
	onStartRanked(): void;
	onStartRound(wager: number): void;
	onAction(action: BlackjackAction): void;
	onForfeit(): void;
	onRestartPractice(): void;
}

export interface DailyRunRenderer {
	bind(handlers: DailyRunRendererHandlers): void;
	setMode(mode: DailyRunMode): void;
	renderPractice(replay: DailyRunReplay): void;
	renderRanked(state: DailyRunState | null): void;
	renderLeaderboard(leaderboard: DailyLeaderboardView): void;
	setPending(pending: boolean): void;
	renderError(message: string): void;
}

function requireElement<T extends Element>(root: ParentNode, testId: string): T {
	const element = root.querySelector<T>(`[data-testid="${testId}"]`);
	if (!element) throw new Error(`Daily Challenge is missing [data-testid="${testId}"]`);
	return element;
}

function renderActiveRound(
	ownerDocument: Document,
	round: NonNullable<DailyRunState['activeRound']>,
	dealerHand: HTMLElement,
	dealerValue: HTMLElement,
	playerHands: HTMLElement,
): void {
	renderBlackjackDealer(ownerDocument, dealerHand, dealerValue, round.dealer, {
		testIdPrefix: 'daily-challenge',
	});
	renderBlackjackPlayerHands(ownerDocument, playerHands, round.playerHands, round.activeHandIndex, {
		testIdPrefix: 'daily-challenge',
		formatWager: formatCurrency,
	});
}

export function createDailyRunRenderer(root: HTMLElement): DailyRunRenderer {
	const authenticated = root.dataset.userId !== undefined && root.dataset.userId !== 'guest';

	const practiceModeEl = requireElement<HTMLButtonElement>(root, 'daily-challenge-mode-practice');
	const rankedModeEl = requireElement<HTMLButtonElement>(root, 'daily-challenge-mode-ranked');
	const signInCtaEl = requireElement(root, 'daily-challenge-sign-in-cta');
	const practiceNoticesEl = requireElement(root, 'daily-challenge-practice-notices');
	const rankedNoticesEl = requireElement(root, 'daily-challenge-ranked-notices');
	const controlsEl = requireElement(root, 'daily-challenge-controls');
	const bankrollEl = requireElement(root, 'daily-challenge-bankroll');
	const committedWagerEl = requireElement(root, 'daily-challenge-committed-wager');
	const roundProgressEl = requireElement(root, 'daily-challenge-round-progress');
	const dealerValueEl = requireElement(root, 'daily-challenge-dealer-value');
	const dealerHandEl = requireElement(root, 'daily-challenge-dealer-hand');
	const playerHandsEl = requireElement(root, 'daily-challenge-player-hands');
	const statusEl = requireElement(root, 'daily-challenge-status');
	const wagerEl = requireElement<HTMLInputElement>(root, 'daily-challenge-wager');
	const startRankedEl = requireElement<HTMLButtonElement>(root, 'daily-challenge-start-ranked');
	const startRoundEl = requireElement<HTMLButtonElement>(root, 'daily-challenge-start-round');
	const actionEls = new Map(
		ACTIONS.map((action) => [
			action,
			requireElement<HTMLButtonElement>(root, `daily-challenge-action-${action}`),
		]),
	);
	const forfeitEl = requireElement<HTMLButtonElement>(root, 'daily-challenge-forfeit');
	const forfeitConfirmEl = requireElement<HTMLButtonElement>(
		root,
		'daily-challenge-forfeit-confirm',
	);
	const forfeitCancelEl = requireElement<HTMLButtonElement>(root, 'daily-challenge-forfeit-cancel');
	const restartPracticeEl = requireElement<HTMLButtonElement>(
		root,
		'daily-challenge-restart-practice',
	);
	const receiptEl = requireElement(root, 'daily-challenge-receipt');
	const receiptEligibilityEl = requireElement(root, 'daily-challenge-receipt-eligibility');
	const receiptBankrollEl = requireElement(root, 'daily-challenge-receipt-bankroll');
	const receiptRoundsEl = requireElement(root, 'daily-challenge-receipt-rounds');
	const rankEl = requireElement(root, 'daily-challenge-rank');
	const percentileEl = requireElement(root, 'daily-challenge-percentile');
	const leaderboardRowsEl = requireElement(root, 'daily-challenge-leaderboard-rows');
	const currentStandingEl = requireElement(root, 'daily-challenge-current-standing');

	let handlers: DailyRunRendererHandlers | null = null;
	let mode: DailyRunMode = 'practice';
	let pending = false;
	let practiceReplay: DailyRunReplay | null = null;
	let rankedState: DailyRunState | null = null;
	let forfeitConfirmVisible = false;

	const activeRound = (): NonNullable<DailyRunState['activeRound']> | null => {
		if (mode === 'ranked') return rankedState?.activeRound ?? null;
		return practiceReplay?.activeRoundPublic ?? null;
	};

	const syncControls = (): void => {
		const round = activeRound();
		const actions = round?.availableActions ?? [];
		const attemptActive = rankedState !== null && rankedState.status === 'active';
		const attemptTerminal = rankedState !== null && rankedState.status !== 'active';

		wagerEl.disabled = pending || round !== null;
		startRoundEl.disabled = pending || round !== null;
		for (const [action, button] of actionEls) {
			button.disabled = pending || !actions.includes(action);
		}
		forfeitEl.disabled = pending;
		restartPracticeEl.disabled = pending;
		// One ranked attempt per period: hide the start while it is being
		// played, disable it forever once the attempt is terminal.
		startRankedEl.hidden = !authenticated || attemptActive;
		startRankedEl.disabled = pending || attemptTerminal;
	};

	const syncModeVisibility = (): void => {
		signInCtaEl.hidden = authenticated;
		rankedModeEl.hidden = !authenticated;
		practiceNoticesEl.hidden = mode !== 'practice';
		rankedNoticesEl.hidden = mode !== 'ranked' || !authenticated;
		forfeitEl.hidden = activeRound() === null;
		forfeitConfirmEl.hidden = !forfeitConfirmVisible;
		forfeitCancelEl.hidden = !forfeitConfirmVisible;
	};

	const clearHands = (): void => {
		dealerHandEl.replaceChildren();
		dealerValueEl.textContent = '';
		playerHandsEl.replaceChildren();
	};

	const renderReceipt = (state: DailyRunState): void => {
		receiptEl.hidden = false;
		receiptEligibilityEl.textContent =
			state.eligible === true ? 'Eligible for ranking' : 'Not eligible for ranking';
		receiptBankrollEl.textContent = formatCurrency(state.availableBankroll);
		receiptRoundsEl.textContent = `${state.roundsCompleted} of ${DAILY_RUN_CONFIG.roundCount} rounds`;
		rankEl.hidden = state.rank === null;
		rankEl.textContent = state.rank === null ? '' : `#${state.rank}`;
		percentileEl.hidden = state.percentile === null;
		percentileEl.textContent =
			state.percentile === null ? '' : `${formatPercentile(state.percentile)} percentile`;
	};

	const renderCurrentView = (): void => {
		forfeitConfirmVisible = false;
		controlsEl.hidden = false;
		clearHands();
		receiptEl.hidden = true;
		syncModeVisibility();
		syncControls();

		if (mode === 'practice') {
			const replay = practiceReplay;
			if (replay === null) return;
			bankrollEl.textContent = formatCurrency(replay.availableBankroll);
			committedWagerEl.textContent = replay.activeRoundPublic
				? formatCurrency(replay.activeRoundPublic.committedWager)
				: '\u2014';
			roundProgressEl.textContent = roundProgressLabel(replay.roundsCompleted);
			if (replay.activeRoundPublic) {
				renderActiveRound(
					root.ownerDocument,
					replay.activeRoundPublic,
					dealerHandEl,
					dealerValueEl,
					playerHandsEl,
				);
				statusEl.textContent = '';
			} else if (replay.status === 'completed') {
				statusEl.textContent = PRACTICE_COMPLETE_STATUS;
			} else if (replay.status === 'forfeited') {
				statusEl.textContent = PRACTICE_FORFEITED_STATUS;
			} else {
				statusEl.textContent = PRACTICE_READY_STATUS;
			}
			return;
		}

		const state = rankedState;
		if (state === null) {
			bankrollEl.textContent = '\u2014';
			committedWagerEl.textContent = '\u2014';
			roundProgressEl.textContent = '';
			statusEl.textContent = RANKED_IDLE_STATUS;
			return;
		}

		bankrollEl.textContent = formatCurrency(state.availableBankroll);
		committedWagerEl.textContent = state.activeRound
			? formatCurrency(state.activeRound.committedWager)
			: '\u2014';
		roundProgressEl.textContent = roundProgressLabel(state.roundsCompleted);
		if (state.activeRound) {
			renderActiveRound(
				root.ownerDocument,
				state.activeRound,
				dealerHandEl,
				dealerValueEl,
				playerHandsEl,
			);
			statusEl.textContent = '';
		}
		if (state.status !== 'active') {
			renderReceipt(state);
		}
	};

	const selectMode = (next: DailyRunMode): void => {
		mode = next;
		renderCurrentView();
		handlers?.onSelectMode(next);
	};

	const submitWager = (): void => {
		if (wagerEl.value === '') return;
		const parsed = Number(wagerEl.value);
		if (
			!Number.isSafeInteger(parsed) ||
			parsed < DAILY_RUN_CONFIG.minimumWager ||
			parsed > DAILY_RUN_CONFIG.maximumWager
		) {
			statusEl.textContent = `Wager must be a whole number between ${DAILY_RUN_CONFIG.minimumWager} and ${DAILY_RUN_CONFIG.maximumWager.toLocaleString('en-US')}.`;
			return;
		}
		handlers?.onStartRound(parsed);
	};

	return {
		bind(nextHandlers) {
			if (handlers) return;
			handlers = nextHandlers;
			practiceModeEl.addEventListener('click', () => selectMode('practice'));
			rankedModeEl.addEventListener('click', () => selectMode('ranked'));
			startRankedEl.addEventListener('click', () => {
				if (!startRankedEl.disabled) handlers?.onStartRanked();
			});
			startRoundEl.addEventListener('click', submitWager);
			for (const [action, button] of actionEls) {
				button.addEventListener('click', () => handlers?.onAction(action));
			}
			forfeitEl.addEventListener('click', () => {
				forfeitConfirmVisible = true;
				syncModeVisibility();
			});
			forfeitCancelEl.addEventListener('click', () => {
				forfeitConfirmVisible = false;
				syncModeVisibility();
			});
			forfeitConfirmEl.addEventListener('click', () => {
				forfeitConfirmVisible = false;
				syncModeVisibility();
				handlers?.onForfeit();
			});
			restartPracticeEl.addEventListener('click', () => handlers?.onRestartPractice());
		},

		setMode(next) {
			if (mode === next) return;
			selectMode(next);
		},

		renderPractice(replay) {
			practiceReplay = replay;
			if (mode === 'practice') renderCurrentView();
			else syncControls();
		},

		renderRanked(state) {
			rankedState = state;
			// A live or terminal ranked attempt always routes Start Round,
			// actions, and forfeit to the run client — never to the local
			// practice replay. Covers start, adopt, resume, and command
			// responses, all of which flow through here.
			if (state !== null && mode !== 'ranked') {
				mode = 'ranked';
				handlers?.onSelectMode('ranked');
			}
			if (mode === 'ranked') renderCurrentView();
			else syncControls();
		},

		renderLeaderboard(leaderboard) {
			leaderboardRowsEl.replaceChildren(
				...leaderboard.entries.map((entry) => {
					const row = document.createElement('li');
					row.dataset.testid = 'daily-challenge-leaderboard-row';
					row.textContent = `#${entry.rank} ${entry.playerName} ${formatCurrency(entry.endingBankroll)}`;
					return row;
				}),
			);
			currentStandingEl.hidden = leaderboard.currentUser === null;
			if (leaderboard.currentUser !== null) {
				const { rank, totalEligible, percentile } = leaderboard.currentUser;
				currentStandingEl.textContent = `#${rank} · ${percentile}% · ${totalEligible} eligible`;
			}
		},

		setPending(next) {
			pending = next;
			root.dataset.pending = String(next);
			syncControls();
		},

		renderError(message) {
			statusEl.textContent = message;
		},
	};
}

// --- local practice controller ---

export interface DailyPracticeControllerDeps {
	/** Seed factory; defaults to a fresh 32-byte `crypto.getRandomValues` draw. */
	createSeed?: () => Uint8Array;
	render(replay: DailyRunReplay): void;
	renderError(message: string): void;
}

export interface DailyPracticeController {
	startRound(wager: number): void;
	action(action: BlackjackAction): void;
	forfeit(): void;
	restart(): void;
	renderCurrent(): void;
}

/** Practice seed per spec: 32 bytes from the platform CSPRNG. */
export function createDailyPracticeSeed(): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function createDailyPracticeController(
	deps: DailyPracticeControllerDeps,
): DailyPracticeController {
	const createSeed = deps.createSeed ?? createDailyPracticeSeed;
	let seed = createSeed();
	let commands: BlackjackRunCommand[] = [];

	const apply = (command: Omit<BlackjackRunCommand, 'sequence'>): void => {
		const candidate: BlackjackRunCommand[] = [
			...commands,
			{ sequence: commands.length, ...command },
		];
		try {
			const replay = replayDailyRun(seed, candidate);
			commands = candidate;
			deps.render(replay);
		} catch (error) {
			if (error instanceof BlackjackRunError && error.code === 'ATTEMPT_COMPLETE') {
				deps.renderError(PRACTICE_OVER_STATUS);
				return;
			}
			deps.renderError(errorMessage(error));
		}
	};

	return {
		startRound(wager) {
			apply({ command: 'start-round', wager });
		},
		action(action) {
			apply({ command: action });
		},
		forfeit() {
			apply({ command: 'forfeit' });
		},
		restart() {
			seed = createSeed();
			commands = [];
			deps.render(replayDailyRun(seed, []));
		},
		renderCurrent() {
			deps.render(replayDailyRun(seed, []));
		},
	};
}

// --- page bootstrap ---

export interface DailyChallengePageDeps {
	/** Shared Task 6 run client; defaults to the browser transport. */
	client?: BlackjackRunClient;
	createSeed?: () => Uint8Array;
	createRenderer?: (root: HTMLElement) => DailyRunRenderer;
	timeoutMs?: number;
}

export async function initDailyChallengePage(
	root: HTMLElement,
	deps: DailyChallengePageDeps = {},
): Promise<void> {
	const periodKeyRaw = root.dataset.periodKey;
	if (typeof periodKeyRaw !== 'string' || !periodKeySchema.safeParse(periodKeyRaw).success) {
		throw new TypeError('Daily page root needs a valid data-period-key');
	}
	const periodKey = periodKeyRaw;
	const authenticated = root.dataset.userId !== undefined && root.dataset.userId !== 'guest';
	const renderer = (deps.createRenderer ?? createDailyRunRenderer)(root);
	const client = deps.client ?? createBlackjackRunClient();
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let mode: DailyRunMode = 'practice';
	let ranked: DailyRunState | null = null;

	const practice = createDailyPracticeController({
		createSeed: deps.createSeed,
		render: (replay) => renderer.renderPractice(replay),
		renderError: (message) => renderer.renderError(message),
	});

	const adoptRanked = (state: DailyRunState | null): void => {
		ranked = state;
		renderer.renderRanked(state);
	};

	const rankedStart = async (): Promise<void> => {
		// One attempt per period: an existing run (active or terminal) is
		// never restarted from the page.
		if (ranked !== null) return;
		renderer.setPending(true);
		try {
			adoptRanked(await client.startDaily(periodKey));
		} catch (error) {
			renderer.renderError(errorMessage(error));
		} finally {
			renderer.setPending(false);
		}
	};

	const rankedCommand = async (command: BlackjackRunClientCommand): Promise<void> => {
		if (!ranked || ranked.status !== 'active') return;
		renderer.setPending(true);
		try {
			adoptRanked(await client.command(ranked.runId, command));
		} catch (error) {
			renderer.renderError(errorMessage(error));
		} finally {
			renderer.setPending(false);
		}
	};

	renderer.bind({
		onSelectMode(next) {
			mode = next;
		},
		onStartRanked() {
			void rankedStart();
		},
		onStartRound(wager) {
			if (mode === 'ranked') {
				void rankedCommand({ command: 'start-round', wager });
			} else {
				practice.startRound(wager);
			}
		},
		onAction(action) {
			if (mode === 'ranked') {
				void rankedCommand({ command: action });
			} else {
				practice.action(action);
			}
		},
		onForfeit() {
			if (mode === 'ranked') {
				void rankedCommand({ command: 'forfeit' });
			} else {
				practice.forfeit();
			}
		},
		onRestartPractice() {
			practice.restart();
		},
	});

	// Local practice is immediately playable with a browser-generated seed.
	practice.renderCurrent();

	if (authenticated) {
		// Authed users adopt their current run through the shared client
		// (404 RUN_NOT_FOUND resolves to the idle start form).
		renderer.setPending(true);
		try {
			adoptRanked(await client.loadCurrent('daily'));
		} catch (error) {
			renderer.renderError(errorMessage(error));
		} finally {
			renderer.setPending(false);
		}
	} else {
		// Guests hit the public daily-current endpoint; its definitive
		// 404 RUN_NOT_FOUND is the expected "no attempt" surface.
		renderer.setPending(true);
		try {
			const { response, data } = await fetchJsonWithTimeout(
				DAILY_CURRENT_PATH,
				{
					method: 'GET',
				},
				timeoutMs,
			);
			if (!(response.status === 404 && errorCode(data) === RUN_NOT_FOUND)) {
				const code = errorCode(data);
				renderer.renderError(
					code
						? code.replaceAll('_', ' ').toLowerCase()
						: `Daily challenge request failed (${response.status})`,
				);
			}
		} catch (error) {
			renderer.renderError(errorMessage(error));
		} finally {
			renderer.setPending(false);
		}
	}

	// The leaderboard is public: guests and authed users both load it.
	try {
		const { response, data } = await fetchJsonWithTimeout(
			`${DAILY_LEADERBOARD_PATH_PREFIX}/${encodeURIComponent(periodKey)}/leaderboard`,
			{ method: 'GET' },
			timeoutMs,
		);
		if (!response.ok) {
			throw new TypeError(`Daily leaderboard request failed (${response.status})`);
		}
		renderer.renderLeaderboard(parseDailyLeaderboardView(data));
	} catch (error) {
		console.error('Daily leaderboard fetch failed', error);
	}
}
