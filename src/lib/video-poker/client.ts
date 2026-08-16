import { setSlotState } from '../card-slot-utils';
import { createPublicGameSettlementController } from '../wallet';
import { VideoPokerGame } from './game';
import { MIN_WAGER } from './paytable';
import type { Card } from '../cards';
import type { VideoPokerRoundResult } from './types';

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

	const statusEl = document.getElementById('video-poker-status');
	const resultEl = document.getElementById('video-poker-result');
	const action = document.getElementById('video-poker-action') as HTMLButtonElement | null;
	const recoveryHost = document.getElementById('video-poker-recovery-host');
	const cardButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-card-index]')];
	const wagerButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-wager]')];

	let wagerMessage: string | null = null;

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
		settlement.syncBalance(state.balance);
		renderCards();

		for (const button of wagerButtons) {
			button.setAttribute('aria-pressed', String(Number(button.dataset.wager) === state.wager));
			button.disabled = state.phase !== 'ready';
		}

		if (resultEl) {
			resultEl.textContent = state.result
				? `${state.result.evaluation.label}: ${state.result.payout} chips (${state.result.netDelta >= 0 ? '+' : ''}${state.result.netDelta} net)`
				: '';
		}

		if (action) {
			action.textContent =
				state.phase === 'ready' ? 'Deal' : state.phase === 'holding' ? 'Draw' : 'New Round';
			action.disabled =
				(state.phase === 'ready' && game.getWagerError(state.wager) !== null) ||
				(state.phase === 'ready' && settlement.isBlocked) ||
				(state.phase === 'complete' && settlement.isBlocked);
		}

		if (statusEl) {
			if (state.phase === 'ready' && state.balance < MIN_WAGER) {
				statusEl.textContent = `Not enough chips to deal.${settlement.isGuestMode ? ' Sign in to get more chips.' : ''}`;
			} else if (settlement.statusMessage) {
				statusEl.textContent = settlement.statusMessage;
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

	const settlement = createPublicGameSettlementController({
		gameKey: 'video-poker',
		root,
		recoveryHost,
		resetLabel: 'Reset hand',
		messages: {
			failed: 'Settlement failed. Retry or reset before starting another hand.',
			retrying: 'Retrying settlement...',
			retryFailed: 'Settlement failed again. Retry or reset the hand.',
		},
		render,
		onAdoptBalance: (balance) => game.setBalance(balance),
		onResetRound: () => {
			if (game.getState().phase === 'complete') game.resetRound();
			wagerMessage = null;
		},
	});
	const game = new VideoPokerGame(settlement.startingBalance);

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

		if (state.phase === 'ready') {
			const wagerError = game.getWagerError(state.wager);
			if (wagerError) {
				wagerMessage = wagerError;
				render();
				return;
			}
			if (settlement.isBlocked) return;
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

			await settlement.completeRound(round.netDelta, game.getState().balance);
			return;
		}

		if (settlement.isBlocked) return;
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
