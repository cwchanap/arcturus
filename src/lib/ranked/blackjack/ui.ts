import { initAchievementToast } from '../../achievement-toast';
import { getAchievementById } from '../../achievements/achievement-rules';
import type { RankedBlackjackAction } from '../protocol';
import type {
	RankedBlackjackRenderer,
	RankedBlackjackRendererHandlers,
	RankedBlackjackResponseV1,
} from './client';
import { renderBlackjackDealer, renderBlackjackPlayerHands } from '../../blackjack/presentation';

const RANKED_PRESENTATION_OPTIONS = {
	testIdPrefix: 'ranked',
	formatWager: (value: number) => `$${new Intl.NumberFormat('en-US').format(value)}`,
} as const;

const ACTIONS: readonly RankedBlackjackAction[] = ['hit', 'stand', 'double-down', 'split'];

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	if (!element) throw new Error(`Ranked Blackjack is missing ${selector}`);
	return element;
}

function formatChips(value: number): string {
	return `$${new Intl.NumberFormat('en-US').format(value)}`;
}

function formatSignedChips(value: number): string {
	if (value === 0) return '$0';
	return `${value > 0 ? '+' : '-'}${formatChips(Math.abs(value))}`;
}

export function createRankedBlackjackRenderer(root: HTMLElement): RankedBlackjackRenderer {
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
	const receiptPanel = requireElement<HTMLElement>(root, '[data-testid="ranked-receipt"]');
	const receiptId = requireElement<HTMLElement>(root, '[data-testid="ranked-receipt-id"]');
	const receiptHash = requireElement<HTMLElement>(root, '[data-testid="ranked-receipt-hash"]');
	const stats = requireElement<HTMLElement>(root, '[data-testid="ranked-stats"]');
	const actionButtons = new Map(
		ACTIONS.map((action) => [
			action,
			requireElement<HTMLButtonElement>(root, `[data-ranked-action="${action}"]`),
		]),
	);
	const toast = requireElement<HTMLElement>(root.ownerDocument, '#ranked-achievement-toast');
	const toastIcon = requireElement<HTMLElement>(root.ownerDocument, '#ranked-achievement-icon');
	const toastName = requireElement<HTMLElement>(root.ownerDocument, '#ranked-achievement-name');
	const achievementToast = initAchievementToast(() => ({
		toast,
		icon: toastIcon,
		name: toastName,
	}));

	let current: RankedBlackjackResponseV1 | null = null;
	let pending = false;
	let handlers: RankedBlackjackRendererHandlers | null = null;
	let renderedReceiptHash: string | null = null;

	const syncControls = (): void => {
		const isActive = current?.status === 'active';
		wager.disabled = pending || isActive;
		start.disabled = pending || isActive;
		for (const [action, button] of actionButtons) {
			button.disabled = pending || !isActive || !current.state.availableActions.includes(action);
		}
	};

	const renderDealer = (response: RankedBlackjackResponseV1): void => {
		renderBlackjackDealer(document, dealerHand, dealerValue, response.state.dealer, {
			testIdPrefix: RANKED_PRESENTATION_OPTIONS.testIdPrefix,
		});
	};

	const renderPlayers = (response: RankedBlackjackResponseV1): void => {
		renderBlackjackPlayerHands(
			document,
			playerHands,
			response.state.playerHands,
			response.state.activeHandIndex,
			RANKED_PRESENTATION_OPTIONS,
		);
	};

	const renderReceipt = (response: RankedBlackjackResponseV1): void => {
		const receipt = response.receipt;
		receiptPanel.hidden = !receipt;
		if (!receipt) {
			receiptId.textContent = '';
			receiptHash.textContent = '';
			stats.textContent = '';
			return;
		}

		receiptId.textContent = receipt.sessionId;
		receiptHash.textContent = receipt.receiptHash;
		const effects = receipt.statsEffects;
		stats.textContent = `${effects.sessionsPlayed} played · ${effects.totalWins} ${
			effects.totalWins === 1 ? 'win' : 'wins'
		} · ${formatSignedChips(effects.netProfit)} net · ${formatChips(
			effects.biggestWin,
		)} biggest win`;

		if (renderedReceiptHash !== receipt.receiptHash) {
			renderedReceiptHash = receipt.receiptHash;
			achievementToast.enqueue(
				receipt.achievementEffects.flatMap((id) => {
					const achievement = getAchievementById(id);
					return achievement
						? [{ id: achievement.id, name: achievement.name, icon: achievement.icon }]
						: [];
				}),
			);
		}
	};

	const render = (response: RankedBlackjackResponseV1 | null): void => {
		current = response;
		if (!response) {
			balance.textContent = formatChips(Number(root.dataset.initialBalance ?? 0));
			committedWager.textContent = '$0';
			status.textContent = 'Choose a wager to begin a ranked session.';
			dealerHand.replaceChildren();
			dealerValue.textContent = '—';
			playerHands.replaceChildren();
			receiptPanel.hidden = true;
			syncControls();
			return;
		}

		balance.textContent = formatChips(response.balance);
		committedWager.textContent = formatChips(response.state.committedWager);
		renderDealer(response);
		renderPlayers(response);
		renderReceipt(response);
		status.textContent =
			response.status === 'active'
				? `Your move · hand ${response.state.activeHandIndex + 1} of ${
						response.state.playerHands.length
					}`
				: response.status === 'expired'
					? 'Session expired · wager forfeited'
					: `${response.state.outcome?.result ?? 'complete'} · receipt verified`;
		syncControls();
	};

	const bind = (nextHandlers: RankedBlackjackRendererHandlers): void => {
		if (handlers) return;
		handlers = nextHandlers;
		start.addEventListener('click', () => {
			void handlers?.onStart(Number(wager.value));
		});
		for (const [action, button] of actionButtons) {
			button.addEventListener('click', () => {
				void handlers?.onAction(action);
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
