import { setSlotState } from '../card-slot-utils';
import { createPublicGameSettlementController } from '../wallet';
import { VideoPokerGame } from './game';
import { MIN_WAGER, MAX_WAGER } from './paytable';
import type { Card } from '../cards';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import {
	videoPokerTranslator,
	getVideoPokerHandLabel,
	formatVideoPokerNet,
	type VIDEO_POKER_MESSAGES,
} from '../i18n/messages/video-poker';
import { formatChips } from '../i18n/messages/common';
import type { MessageKey } from '../i18n/translate';
import type { VideoPokerRoundResult, VideoPokerWagerErrorCode } from './types';

const WAGER_ERROR_KEYS: Record<
	VideoPokerWagerErrorCode,
	MessageKey<typeof VIDEO_POKER_MESSAGES>
> = {
	'invalid-limits': 'errorInvalidLimits',
	'invalid-range': 'errorInvalidRange',
	'out-of-range': 'errorOutOfRange',
	'whole-number-required': 'errorWholeNumber',
	'insufficient-balance': 'errorInsufficientBalance',
};

const SUIT_NAME_KEYS: Record<Card['suit'], MessageKey<typeof VIDEO_POKER_MESSAGES>> = {
	hearts: 'suitHearts',
	diamonds: 'suitDiamonds',
	clubs: 'suitClubs',
	spades: 'suitSpades',
};

function rankLabel(rank: Card['rank']): string {
	if (rank === 11) return 'J';
	if (rank === 12) return 'Q';
	if (rank === 13) return 'K';
	if (rank === 14) return 'A';
	return String(rank);
}

function wagerErrorText(
	t: ReturnType<typeof videoPokerTranslator>,
	locale: Locale,
	code: VideoPokerWagerErrorCode,
): string {
	if (code === 'out-of-range') {
		return t('errorOutOfRange', {
			min: formatChips(MIN_WAGER, locale),
			max: formatChips(MAX_WAGER, locale),
		});
	}
	return t(WAGER_ERROR_KEYS[code]);
}

export function initVideoPokerClient(): void {
	if (typeof window === 'undefined') return;

	const root = document.getElementById('video-poker-root');
	if (!root) return;

	const locale = getDocumentLocale(root.ownerDocument);
	const t = videoPokerTranslator(locale);

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
				button.setAttribute('aria-label', t('cardAria', { number: String(index + 1) }));
			} else {
				setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
				button.dataset.cardId = `${card.rank}-${card.suit}`;
				// Rank glyphs stay invariant; the suit noun is localized.
				button.setAttribute(
					'aria-label',
					t('holdCardAria', { rank: rankLabel(card.rank), suit: t(SUIT_NAME_KEYS[card.suit]) }),
				);
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
				? t('result', {
						label: getVideoPokerHandLabel(locale, state.result.evaluation.category),
						payout: formatChips(state.result.payout, locale),
						net: formatVideoPokerNet(locale, state.result.netDelta),
					})
				: '';
		}

		if (action) {
			action.textContent =
				state.phase === 'ready' ? t('deal') : state.phase === 'holding' ? t('draw') : t('newRound');
			action.disabled =
				(state.phase === 'ready' && game.getWagerError(state.wager) !== null) ||
				(state.phase === 'ready' && settlement.isBlocked) ||
				(state.phase === 'complete' && settlement.isBlocked);
		}

		if (statusEl) {
			if (state.phase === 'ready' && state.balance < MIN_WAGER) {
				statusEl.textContent = `${t('notEnoughChips')}${settlement.isGuestMode ? ` ${t('signInForChips')}` : ''}`;
			} else if (settlement.statusMessage) {
				statusEl.textContent = settlement.statusMessage;
			} else if (wagerMessage) {
				statusEl.textContent = wagerMessage;
			} else {
				statusEl.textContent =
					state.phase === 'ready'
						? t('chooseWagerDeal')
						: state.phase === 'holding'
							? t('holdCards')
							: t('roundComplete');
			}
		}
	}

	const settlement = createPublicGameSettlementController({
		gameKey: 'video-poker',
		root,
		recoveryHost,
		resetLabel: t('resetHand'),
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
	const game = new VideoPokerGame(settlement.startingBalance);

	for (const button of wagerButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'ready') return;
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

	for (const button of cardButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'holding') return;
			try {
				game.toggleHold(Number(button.dataset.cardIndex));
				render();
			} catch (_error) {
				wagerMessage = t('unableToHold');
				render();
			}
		});
	}

	async function onPrimaryAction(): Promise<void> {
		const state = game.getState();

		if (state.phase === 'ready') {
			const wagerError = game.getWagerError(state.wager);
			if (wagerError) {
				wagerMessage = wagerErrorText(t, locale, wagerError);
				render();
				return;
			}
			if (settlement.isBlocked) return;
			try {
				game.deal();
				wagerMessage = null;
				render();
			} catch (_error) {
				wagerMessage = t('unableToDeal');
				render();
			}
			return;
		}

		if (state.phase === 'holding') {
			let round: VideoPokerRoundResult;
			try {
				round = game.draw();
				render();
			} catch (_error) {
				wagerMessage = t('unableToDraw');
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
		} catch (_error) {
			wagerMessage = t('unableToNewHand');
			render();
		}
	}

	action?.addEventListener('click', () => {
		void onPrimaryAction();
	});
	render();
}
