import { setSlotState } from '../card-slot-utils';
import { createPublicGameSettlementController } from '../wallet';
import type { Card } from '../cards';
import { isPaiGowJoker } from './cards';
import { PaiGowPokerGame } from './game';
import { getArrangement } from './rules';
import type { PaiGowCard, PaiGowCategory, PaiGowRoundResult } from './types';

const CATEGORY_LABELS: Record<PaiGowCategory, string> = {
	'five-aces': 'Five Aces',
	'royal-flush': 'Royal Flush',
	'straight-flush': 'Straight Flush',
	'four-of-kind': 'Four of a Kind',
	'full-house': 'Full House',
	flush: 'Flush',
	straight: 'Straight',
	'three-of-kind': 'Three of a Kind',
	'two-pair': 'Two Pair',
	pair: 'Pair',
	'high-card': 'High Card',
};

function rankLabel(rank: Card['rank']): string {
	if (rank === 11) return 'J';
	if (rank === 12) return 'Q';
	if (rank === 13) return 'K';
	if (rank === 14) return 'A';
	return String(rank);
}

function displayCard(card: PaiGowCard): { rank: string; suit: string } {
	if (isPaiGowJoker(card)) return { rank: '★', suit: '★' };
	return { rank: rankLabel(card.rank), suit: card.suit };
}

function resultText(result: PaiGowRoundResult): string {
	const outcome =
		result.outcome === 'win' ? 'Player wins' : result.outcome === 'loss' ? 'Loss' : 'Push';
	const delta = result.netDelta > 0 ? `+${result.netDelta}` : String(result.netDelta);
	return `${outcome} · ${delta} net`;
}

export function initPaiGowPokerClient(): void {
	if (typeof window === 'undefined') return;

	const root = document.getElementById('pai-gow-root');
	if (!root) return;

	const statusEl = root.querySelector<HTMLElement>('#pai-gow-status');
	const recoveryHost = root.querySelector<HTMLElement>('#pai-gow-recovery-host');
	const playerButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-card-index]')];
	const dealerHighSlots = [0, 1, 2, 3, 4].map((index) =>
		root.querySelector(`#pai-gow-dealer-high-slot-${index}`),
	);
	const dealerLowSlots = [0, 1].map((index) =>
		root.querySelector(`#pai-gow-dealer-low-slot-${index}`),
	);
	const wagerButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-wager]')];
	const dealButton = root.querySelector<HTMLButtonElement>('#deal-button');
	const autoArrangeButton = root.querySelector<HTMLButtonElement>('#auto-arrange-button');
	const resetButton = root.querySelector<HTMLButtonElement>('#reset-button');
	const confirmButton = root.querySelector<HTMLButtonElement>('#confirm-button');
	const newRoundButton = root.querySelector<HTMLButtonElement>('#new-round-button');
	let wagerMessage: string | null = null;

	function renderDealerSlots(state: ReturnType<PaiGowPokerGame['getState']>): void {
		const dealerCards = state.result?.dealer;
		for (const [index, slot] of dealerHighSlots.entries()) {
			if (!slot) continue;
			if (state.phase === 'betting') setSlotState(slot, 'placeholder');
			else if (state.phase === 'arranging') setSlotState(slot, 'facedown');
			else if (dealerCards?.high[index]) {
				setSlotState(slot, 'card', displayCard(dealerCards.high[index]));
			} else setSlotState(slot, 'placeholder');
		}
		for (const [index, slot] of dealerLowSlots.entries()) {
			if (!slot) continue;
			if (state.phase === 'betting') setSlotState(slot, 'placeholder');
			else if (state.phase === 'arranging') setSlotState(slot, 'facedown');
			else if (dealerCards?.low[index]) {
				setSlotState(slot, 'card', displayCard(dealerCards.low[index]));
			} else setSlotState(slot, 'placeholder');
		}
	}

	function render(): void {
		const state = game.getState();
		settlement.syncBalance(state.balance);

		for (const button of playerButtons) {
			const index = Number(button.dataset.cardIndex);
			const slot = button.querySelector('[data-card-slot]');
			const card = state.playerCards[index];
			const selected = state.lowIndexes.includes(index);
			if (slot) {
				if (card) setSlotState(slot, 'card', displayCard(card));
				else setSlotState(slot, 'placeholder');
			}
			button.setAttribute('aria-pressed', String(selected));
			button.dataset.low = String(selected);
			button.classList.toggle('pai-gow-low-selected', selected);
			button.disabled = state.phase !== 'arranging';
			button.setAttribute('aria-label', `Card ${index + 1}`);
		}

		renderDealerSlots(state);

		for (const button of wagerButtons) {
			button.setAttribute('aria-pressed', String(Number(button.dataset.wager) === state.wager));
			button.disabled = state.phase !== 'betting' || settlement.isBlocked;
		}

		if (dealButton) {
			dealButton.hidden = state.phase !== 'betting';
			dealButton.disabled = settlement.isBlocked || game.getWagerError(state.wager) !== null;
		}
		if (autoArrangeButton) {
			autoArrangeButton.hidden = state.phase !== 'arranging';
			autoArrangeButton.disabled = state.phase !== 'arranging' || settlement.isBlocked;
		}
		if (resetButton) {
			resetButton.hidden = state.phase !== 'arranging';
			resetButton.disabled = state.phase !== 'arranging' || settlement.isBlocked;
		}
		if (confirmButton) {
			confirmButton.hidden = state.phase !== 'arranging';
			confirmButton.disabled =
				state.phase !== 'arranging' || settlement.isBlocked || game.getArrangementError() !== null;
		}
		if (newRoundButton) {
			newRoundButton.hidden = state.phase !== 'complete';
			newRoundButton.disabled = settlement.isBlocked;
		}

		if (statusEl) {
			if (settlement.statusMessage) {
				statusEl.textContent = settlement.statusMessage;
			} else if (wagerMessage) {
				statusEl.textContent = wagerMessage;
			} else if (state.phase === 'betting') {
				statusEl.textContent = 'Choose a wager, then deal.';
			} else if (state.phase === 'complete' && state.result) {
				statusEl.textContent = resultText(state.result);
			} else if (state.lowIndexes.length < 2) {
				statusEl.textContent = 'Choose two cards for the Low hand.';
			} else {
				const arrangement = getArrangement(state.playerCards, state.lowIndexes);
				const error = game.getArrangementError();
				statusEl.textContent = error
					? error
					: arrangement
						? `High: ${CATEGORY_LABELS[arrangement.highRanking.category]} · Low: ${CATEGORY_LABELS[arrangement.lowRanking.category]}`
						: 'Choose two cards for the Low hand.';
			}
		}
	}

	const settlement = createPublicGameSettlementController({
		gameKey: 'pai-gow-poker',
		root,
		recoveryHost,
		resetLabel: 'Reset round',
		messages: {
			failed: 'Settlement failed. Retry or reset before starting another round.',
			retrying: 'Retrying settlement...',
			retryFailed: 'Settlement failed again. Retry or reset before starting another round.',
		},
		render,
		onAdoptBalance: (balance) => game.setBalance(balance),
		onResetRound: () => {
			if (game.getState().phase === 'complete') game.resetRound();
			wagerMessage = null;
		},
	});
	const game = new PaiGowPokerGame(settlement.startingBalance);

	for (const button of wagerButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'betting') return;
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

	for (const button of playerButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'arranging') return;
			game.toggleLowCard(Number(button.dataset.cardIndex));
			render();
		});
	}

	dealButton?.addEventListener('click', () => {
		if (game.getState().phase !== 'betting' || settlement.isBlocked) return;
		const error = game.getWagerError(game.getState().wager);
		if (error) {
			wagerMessage = error;
			render();
			return;
		}
		game.deal();
		wagerMessage = null;
		render();
	});

	autoArrangeButton?.addEventListener('click', () => {
		if (game.getState().phase !== 'arranging' || settlement.isBlocked) return;
		game.autoArrange();
		render();
	});

	resetButton?.addEventListener('click', () => {
		if (game.getState().phase !== 'arranging' || settlement.isBlocked) return;
		game.resetArrangement();
		render();
	});

	async function completeRound(): Promise<void> {
		if (
			game.getState().phase !== 'arranging' ||
			settlement.isBlocked ||
			game.getArrangementError() !== null
		) {
			return;
		}
		const result = game.confirm();
		render();
		await settlement.completeRound(result.netDelta, game.getState().balance);
		render();
	}

	confirmButton?.addEventListener('click', () => {
		void completeRound();
	});

	newRoundButton?.addEventListener('click', () => {
		if (settlement.isBlocked || game.getState().phase !== 'complete') return;
		game.resetRound();
		wagerMessage = null;
		render();
	});

	render();
}
