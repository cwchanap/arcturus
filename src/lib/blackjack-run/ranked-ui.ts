import { renderBlackjackDealer, renderBlackjackPlayerHands } from '../blackjack/presentation';
import { MAXIMUM_WAGER, MINIMUM_WAGER } from './ranked';
import type { BlackjackAction, BlackjackRunPublicState } from './protocol';

/**
 * Ranked Blackjack Run DOM renderer.
 *
 * Renders the Ranked DOM behavior (wager input/validation, cards, legal
 * actions, countdown, pending state, error state, terminal Result) onto the
 * unified blackjack-run public state. Receipt/hash/commitment/version/
 * reward-effect display, the achievement toast, and the multiplayer
 * wallet-lock copy are deliberately absent.
 */

export type RankedRunState = Extract<BlackjackRunPublicState, { mode: 'ranked' }>;

export interface RankedRunRendererHandlers {
	onStart: (wager: number) => void;
	onAction: (action: BlackjackAction) => void;
}

export interface RankedRunRenderer {
	bind(handlers: RankedRunRendererHandlers): void;
	getWager(): number;
	render(state: RankedRunState | null): void;
	setPending(pending: boolean): void;
	renderCountdown(secondsRemaining: number): void;
	renderError(message: string): void;
}

const ACTIONS: readonly BlackjackAction[] = ['hit', 'stand', 'double-down', 'split'];

function formatChips(value: number): string {
	return `$${new Intl.NumberFormat('en-US').format(value)}`;
}

const PRESENTATION_OPTIONS = {
	testIdPrefix: 'ranked',
	formatWager: formatChips,
} as const;

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	if (!element) throw new Error(`Ranked Blackjack is missing ${selector}`);
	return element;
}

function formatSignedChips(value: number): string {
	if (value === 0) return '$0';
	return `${value > 0 ? '+' : '-'}${formatChips(Math.abs(value))}`;
}

export function createRankedRunRenderer(root: HTMLElement): RankedRunRenderer {
	const wager = requireElement<HTMLInputElement>(root, '[data-testid="ranked-wager"]');
	const start = requireElement<HTMLButtonElement>(root, '[data-testid="ranked-start"]');
	const countdown = requireElement<HTMLElement>(root, '[data-testid="ranked-countdown"]');
	const dealerHand = requireElement<HTMLElement>(root, '[data-testid="ranked-dealer-hand"]');
	const dealerValue = requireElement<HTMLElement>(root, '[data-testid="ranked-dealer-value"]');
	const playerHands = requireElement<HTMLElement>(root, '[data-testid="ranked-player-hands"]');
	const status = requireElement<HTMLElement>(root, '[data-testid="ranked-status"]');
	const committedWager = requireElement<HTMLElement>(
		root,
		'[data-testid="ranked-committed-wager"]',
	);
	const balance = requireElement<HTMLElement>(root, '[data-testid="ranked-balance"]');
	const resultPanel = requireElement<HTMLElement>(root, '[data-testid="ranked-result"]');
	const resultOutcome = requireElement<HTMLElement>(root, '[data-testid="ranked-result-outcome"]');
	const resultWager = requireElement<HTMLElement>(root, '[data-testid="ranked-result-wager"]');
	const resultPayout = requireElement<HTMLElement>(root, '[data-testid="ranked-result-payout"]');
	const resultNet = requireElement<HTMLElement>(root, '[data-testid="ranked-result-net"]');
	const resultBalance = requireElement<HTMLElement>(root, '[data-testid="ranked-result-balance"]');
	const actionButtons = new Map(
		ACTIONS.map((action) => [
			action,
			requireElement<HTMLButtonElement>(root, `[data-ranked-action="${action}"]`),
		]),
	);

	let current: RankedRunState | null = null;
	let pending = false;
	let handlers: RankedRunRendererHandlers | null = null;

	// Keep the shared AppLayout header balance pill in sync with the server
	// account balance after an initial/additional stake debit or a payout.
	const syncHeaderBalance = (nextBalance: number): void => {
		const formatted = nextBalance.toLocaleString('en-US');
		root.ownerDocument.querySelectorAll<HTMLElement>('[data-chip-balance]').forEach((element) => {
			element.textContent = `${formatted} chips`;
		});
	};

	const syncControls = (): void => {
		const isActive = current?.status === 'active';
		wager.disabled = pending || isActive;
		start.disabled = pending || isActive;
		for (const [action, button] of actionButtons) {
			// Without a rendered active state every action stays disabled
			// (idle/terminal render); only an active run exposes legal actions.
			button.disabled =
				pending ||
				current === null ||
				current.status !== 'active' ||
				!current.availableActions.includes(action);
		}
	};

	const renderDealer = (state: RankedRunState): void => {
		renderBlackjackDealer(root.ownerDocument, dealerHand, dealerValue, state.dealer, {
			testIdPrefix: PRESENTATION_OPTIONS.testIdPrefix,
		});
	};

	const renderPlayers = (state: RankedRunState): void => {
		renderBlackjackPlayerHands(
			root.ownerDocument,
			playerHands,
			state.playerHands,
			state.activeHandIndex,
			PRESENTATION_OPTIONS,
		);
	};

	const renderResult = (state: RankedRunState): void => {
		const terminal = state.status === 'settled' || state.status === 'expired';
		resultPanel.hidden = !terminal;
		if (!terminal) {
			resultOutcome.textContent = '';
			resultWager.textContent = '';
			resultPayout.textContent = '';
			resultNet.textContent = '';
			resultBalance.textContent = '';
			return;
		}
		const outcome = state.outcome;
		resultOutcome.textContent = outcome
			? outcome.result === 'win'
				? 'Win'
				: outcome.result === 'loss'
					? 'Loss'
					: 'Push'
			: '—';
		resultWager.textContent = formatChips(state.committedWager);
		resultPayout.textContent = outcome ? formatChips(outcome.payout) : '$0';
		resultNet.textContent = outcome ? formatSignedChips(outcome.gameNetDelta) : '$0';
		resultBalance.textContent = formatChips(state.balance);
	};

	const render = (state: RankedRunState | null): void => {
		current = state;
		if (!state) {
			balance.textContent = formatChips(Number(root.dataset.initialBalance ?? 0));
			committedWager.textContent = '$0';
			status.textContent = 'Choose a wager to begin a ranked run.';
			countdown.textContent = '—';
			dealerHand.replaceChildren();
			dealerValue.textContent = '—';
			playerHands.replaceChildren();
			resultPanel.hidden = true;
			syncControls();
			return;
		}

		balance.textContent = formatChips(state.balance);
		syncHeaderBalance(state.balance);
		committedWager.textContent = formatChips(state.committedWager);
		renderDealer(state);
		renderPlayers(state);
		renderResult(state);
		status.textContent =
			state.status === 'active'
				? `Your move · hand ${state.activeHandIndex + 1} of ${state.playerHands.length}`
				: state.status === 'expired'
					? 'Run expired · wager forfeited'
					: `${state.outcome?.result ?? 'complete'} · run settled`;
		if (state.status !== 'active') {
			countdown.textContent = '—';
		}
		syncControls();
	};

	const bind = (nextHandlers: RankedRunRendererHandlers): void => {
		if (handlers) return;
		handlers = nextHandlers;
		start.addEventListener('click', () => {
			const candidate = Number(wager.value);
			if (
				!Number.isSafeInteger(candidate) ||
				candidate < MINIMUM_WAGER ||
				candidate > MAXIMUM_WAGER
			) {
				status.textContent = `Wager must be a whole number between ${MINIMUM_WAGER} and ${MAXIMUM_WAGER.toLocaleString('en-US')}.`;
				return;
			}
			handlers?.onStart(candidate);
		});
		for (const [action, button] of actionButtons) {
			button.addEventListener('click', () => {
				handlers?.onAction(action);
			});
		}
	};

	return {
		bind,
		getWager: () => Number(wager.value),
		render,
		setPending(nextPending) {
			pending = nextPending;
			root.dataset.pending = String(nextPending);
			syncControls();
		},
		renderCountdown(secondsRemaining) {
			const safeSeconds = Math.max(0, Math.trunc(secondsRemaining));
			const minutes = Math.floor(safeSeconds / 60);
			const seconds = String(safeSeconds % 60).padStart(2, '0');
			countdown.textContent = `${minutes}:${seconds}`;
		},
		renderError(message) {
			status.textContent = message;
		},
	};
}
