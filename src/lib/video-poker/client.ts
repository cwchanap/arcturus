import { setSlotState } from '../card-slot-utils';
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
	type SettleRoundCommand,
	type SettleRoundResult,
} from '../wallet';
import { VideoPokerGame } from './game';
import { MIN_WAGER } from './paytable';
import type { Card } from '../cards';
import type { VideoPokerRoundResult } from './types';

const GAME_KEY = 'video-poker';

export function buildVideoPokerSettlementCommand(
	settlementId: string,
	result: Pick<VideoPokerRoundResult, 'netDelta'>,
): SettleRoundCommand {
	return {
		settlementId,
		game: 'video-poker',
		delta: result.netDelta,
		stats: {
			rounds: 1,
			wins: result.netDelta > 0 ? 1 : 0,
			losses: result.netDelta < 0 ? 1 : 0,
			biggestWin: Math.max(result.netDelta, 0),
		},
	};
}

function rankLabel(rank: Card['rank']): string {
	if (rank === 11) return 'J';
	if (rank === 12) return 'Q';
	if (rank === 13) return 'K';
	if (rank === 14) return 'A';
	return String(rank);
}

export function initVideoPokerClient(): void {
	if (typeof window === 'undefined') return;

	const root = document.getElementById('video-poker-root');
	if (!root) return;

	const balanceEl = document.getElementById('chip-balance');
	const statusEl = document.getElementById('video-poker-status');
	const resultEl = document.getElementById('video-poker-result');
	const action = document.getElementById('video-poker-action') as HTMLButtonElement | null;
	const recoveryHost = document.getElementById('video-poker-recovery-host');
	const cardButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-card-index]')];
	const wagerButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-wager]')];

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const isGuestMode = isGuestModeValue(root.dataset.guestMode ?? 'false');
	const initialBalance = Number(root.dataset.initialBalance ?? '1000');
	const startingBalance = isGuestMode
		? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
		: initialBalance;
	const game = new VideoPokerGame(startingBalance);
	const gate = createSettlementGate();
	let serverSyncedBalance = startingBalance;
	let wagerMessage: string | null = null;
	let settlementMessage: string | null = null;

	function renderCards(): void {
		const state = game.getState();
		for (const button of cardButtons) {
			const index = Number(button.dataset.cardIndex);
			const slot = document.getElementById(`video-poker-slot-${index}`);
			if (!slot) continue;
			const card = state.hand[index];
			const held = state.heldIndexes.includes(index);

			if (!card) {
				setSlotState(slot, 'placeholder');
				button.dataset.cardId = '';
				button.setAttribute('aria-label', `Card ${index + 1}`);
			} else {
				setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
				button.dataset.cardId = `${card.rank}-${card.suit}`;
				button.setAttribute('aria-label', `Hold ${rankLabel(card.rank)} of ${card.suit}`);
			}

			button.setAttribute('aria-pressed', String(held));
			button.disabled = state.phase !== 'holding';
		}
	}

	function render(): void {
		const state = game.getState();
		renderCards();

		const formattedBalance = state.balance.toLocaleString('en-US');
		if (balanceEl) balanceEl.textContent = formattedBalance;
		document.querySelectorAll<HTMLElement>('[data-chip-balance]').forEach((el) => {
			el.textContent = `${formattedBalance} chips`;
		});

		for (const button of wagerButtons) {
			button.setAttribute('aria-pressed', String(Number(button.dataset.wager) === state.wager));
			button.disabled = state.phase !== 'ready';
		}

		if (resultEl) {
			resultEl.textContent = state.result
				? `${state.result.evaluation.label}: ${state.result.payout} chips (${state.result.netDelta >= 0 ? '+' : ''}${state.result.netDelta} net)`
				: '';
		}

		const settlementBlocked = !isGuestMode && gate.isBlocked;
		if (action) {
			action.textContent =
				state.phase === 'ready' ? 'Deal' : state.phase === 'holding' ? 'Draw' : 'New Round';
			action.disabled =
				(state.phase === 'ready' && game.getWagerError(state.wager) !== null) ||
				(state.phase === 'ready' && settlementBlocked) ||
				(state.phase === 'complete' && settlementBlocked);
		}

		if (statusEl) {
			if (state.phase === 'ready' && state.balance < MIN_WAGER) {
				statusEl.textContent = `Not enough chips to deal.${isGuestMode ? ' Sign in to get more chips.' : ''}`;
			} else if (settlementMessage) {
				statusEl.textContent = settlementMessage;
			} else if (wagerMessage) {
				statusEl.textContent = wagerMessage;
			} else {
				statusEl.textContent =
					state.phase === 'ready'
						? 'Choose a wager, then deal.'
						: state.phase === 'holding'
							? 'Hold any cards, then draw.'
							: 'Round complete. Start a new round when ready.';
			}
		}
	}

	const recovery = ensureSettlementRecoveryControls({
		attachTo: recoveryHost,
		containerId: 'video-poker-settlement-recovery',
		retryId: 'video-poker-retry-settlement',
		resetId: 'video-poker-reset-settlement',
		containerClass: 'hidden mt-4 flex flex-wrap justify-center gap-3',
		retryLabel: 'Retry settlement',
		resetLabel: 'Reset hand',
		retryClass: 'deco-btn px-4 py-2 rounded-lg',
		resetClass: 'deco-btn px-4 py-2 rounded-lg',
	});

	function showSettlementRecovery(message: string): void {
		settlementMessage = message;
		recovery.container?.classList.remove('hidden');
		render();
	}

	function hideSettlementRecovery(): void {
		settlementMessage = null;
		recovery.container?.classList.add('hidden');
	}

	function adoptSettlementResult(result: SettleRoundResult): void {
		serverSyncedBalance = result.balance;
		game.setBalance(result.balance);
		hideSettlementRecovery();
		if (result.newAchievements?.length) {
			window.dispatchEvent(
				new CustomEvent('achievement-earned', {
					detail: { achievements: result.newAchievements },
				}),
			);
		}
	}

	recovery.retry?.addEventListener('click', async () => {
		if (!gate.pending) return;
		if (recovery.retry) recovery.retry.disabled = true;
		if (recovery.reset) recovery.reset.disabled = true;
		settlementMessage = 'Retrying settlement...';
		render();
		try {
			const result = await gate.retry();
			if (result) {
				adoptSettlementResult(result);
				render();
			}
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Video Poker retry failed:', error);
			showSettlementRecovery('Settlement failed again. Retry or reset the hand.');
		} finally {
			if (recovery.retry) recovery.retry.disabled = false;
			if (recovery.reset) recovery.reset.disabled = false;
		}
	});

	recovery.reset?.addEventListener('click', () => {
		gate.reset();
		game.setBalance(serverSyncedBalance);
		if (game.getState().phase === 'complete') game.resetRound();
		hideSettlementRecovery();
		wagerMessage = null;
		render();
	});

	for (const button of wagerButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'ready') return;
			const wager = Number(button.dataset.wager);
			const error = game.getWagerError(wager);
			if (error) {
				wagerMessage = error;
				render();
				return;
			}
			game.setWager(wager);
			wagerMessage = null;
			render();
		});
	}

	for (const button of cardButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'holding') return;
			try {
				game.toggleHold(Number(button.dataset.cardIndex));
				render();
			} catch (error) {
				wagerMessage = error instanceof Error ? error.message : 'Unable to hold card';
				render();
			}
		});
	}

	async function onPrimaryAction(): Promise<void> {
		const state = game.getState();
		const settlementBlocked = !isGuestMode && gate.isBlocked;

		if (state.phase === 'ready') {
			const wagerError = game.getWagerError(state.wager);
			if (wagerError) {
				wagerMessage = wagerError;
				render();
				return;
			}
			if (settlementBlocked) return;
			try {
				game.deal();
				wagerMessage = null;
				render();
			} catch (error) {
				wagerMessage = error instanceof Error ? error.message : 'Unable to deal';
				render();
			}
			return;
		}

		if (state.phase === 'holding') {
			let round: VideoPokerRoundResult;
			try {
				round = game.draw();
				render();
			} catch (error) {
				wagerMessage = error instanceof Error ? error.message : 'Unable to draw';
				render();
				return;
			}

			if (!shouldSyncAccountChips({ isGuestMode })) {
				persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance);
				return;
			}

			try {
				const settlement = gate.settle(
					buildVideoPokerSettlementCommand(newSettlementId('video-poker'), round),
				);
				render();
				const result = await settlement;
				adoptSettlementResult(result);
			} catch (error) {
				console.error('[WALLET_SETTLEMENT] Video Poker settlement failed:', error);
				showSettlementRecovery('Settlement failed. Retry or reset before starting another hand.');
			}
			render();
			return;
		}

		if (settlementBlocked) return;
		try {
			game.resetRound();
			wagerMessage = null;
			render();
		} catch (error) {
			wagerMessage = error instanceof Error ? error.message : 'Unable to start a new hand';
			render();
		}
	}

	action?.addEventListener('click', () => {
		void onPrimaryAction();
	});
	render();
}
