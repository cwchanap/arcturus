import { setSlotState } from '../card-slot-utils';
import { createPublicGameSettlementController } from '../wallet';
import type { Card } from '../cards';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import {
	paiGowPokerTranslator,
	getPaiGowCategoryLabel,
	getPaiGowCardName,
	formatPaiGowNet,
	type PAI_GOW_POKER_MESSAGES,
} from '../i18n/messages/pai-gow-poker';
import type { MessageKey } from '../i18n/translate';
import { isPaiGowJoker } from './cards';
import { PaiGowPokerGame, MAX_WAGER, MIN_WAGER } from './game';
import { getArrangement } from './rules';
import type {
	PaiGowArrangementErrorCode,
	PaiGowCard,
	PaiGowRoundResult,
	PaiGowWagerErrorCode,
} from './types';

const WAGER_ERROR_KEYS: Record<PaiGowWagerErrorCode, MessageKey<typeof PAI_GOW_POKER_MESSAGES>> = {
	'invalid-limits': 'errorInvalidLimits',
	'invalid-range': 'errorInvalidRange',
	'out-of-range': 'errorOutOfRange',
	'whole-number-required': 'errorWholeNumber',
	'insufficient-balance': 'errorInsufficientBalance',
};

const ARRANGEMENT_ERROR_KEYS: Record<
	PaiGowArrangementErrorCode,
	MessageKey<typeof PAI_GOW_POKER_MESSAGES>
> = {
	'exactly-seven-cards': 'errorExactlySevenCards',
	'exactly-two-low-indexes': 'errorExactlyTwoLowIndexes',
	'whole-number-indexes': 'errorWholeNumberIndexes',
	'distinct-indexes': 'errorDistinctIndexes',
	'indexes-in-range': 'errorIndexesInRange',
	'high-hand-rank': 'errorHighHandRank',
};

// Visible rank glyphs stay invariant; the full rank name is localized for
// accessibility through getPaiGowCardName.
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

function wagerErrorText(
	t: ReturnType<typeof paiGowPokerTranslator>,
	locale: Locale,
	code: PaiGowWagerErrorCode,
): string {
	if (code === 'out-of-range') {
		return t('errorOutOfRange', {
			min: formatChips(MIN_WAGER, locale),
			max: formatChips(MAX_WAGER, locale),
		});
	}
	return t(WAGER_ERROR_KEYS[code]);
}

function resultText(
	t: ReturnType<typeof paiGowPokerTranslator>,
	locale: Locale,
	result: PaiGowRoundResult,
): string {
	const key =
		result.outcome === 'win'
			? 'resultWin'
			: result.outcome === 'loss'
				? 'resultLoss'
				: 'resultPush';
	return t(key, { net: formatPaiGowNet(locale, result.netDelta) });
}

export function initPaiGowPokerClient(): void {
	if (typeof window === 'undefined') return;

	const root = document.getElementById('pai-gow-root');
	if (!root) return;

	const locale = getDocumentLocale(root.ownerDocument);
	const t = paiGowPokerTranslator(locale);

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
			button.setAttribute(
				'aria-label',
				card
					? t('cardAriaWithCard', {
							number: String(index + 1),
							card: getPaiGowCardName(locale, card),
						})
					: t('cardAria', { number: String(index + 1) }),
			);
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
				statusEl.textContent = t('chooseWager');
			} else if (state.phase === 'complete' && state.result) {
				statusEl.textContent = resultText(t, locale, state.result);
			} else if (state.lowIndexes.length < 2) {
				statusEl.textContent = t('chooseLowCards');
			} else {
				const arrangement = getArrangement(state.playerCards, state.lowIndexes);
				const error = game.getArrangementError();
				statusEl.textContent = error
					? t(ARRANGEMENT_ERROR_KEYS[error])
					: arrangement
						? t('arrangementStatus', {
								high: getPaiGowCategoryLabel(locale, arrangement.highRanking.category),
								low: getPaiGowCategoryLabel(locale, arrangement.lowRanking.category),
							})
						: t('chooseLowCards');
			}
		}
	}

	const settlement = createPublicGameSettlementController({
		gameKey: 'pai-gow-poker',
		root,
		recoveryHost,
		resetLabel: t('resetRound'),
		messages: {
			failed: t('settlementFailed'),
			retrying: t('retryingSettlement'),
			retryFailed: t('settlementRetryFailed'),
			retryLabel: t('retrySettlement'),
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
				wagerMessage = wagerErrorText(t, locale, error);
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
			wagerMessage = wagerErrorText(t, locale, error);
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
