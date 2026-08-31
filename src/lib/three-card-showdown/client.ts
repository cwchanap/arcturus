import { setSlotState } from '../card-slot-utils';
import { createPublicGameSettlementController } from '../wallet';
import type { Card } from '../cards';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import {
	threeCardShowdownTranslator,
	formatThreeCardShowdownNet,
	type THREE_CARD_SHOWDOWN_MESSAGES,
} from '../i18n/messages/three-card-showdown';
import { formatChips } from '../i18n/messages/common';
import type { MessageKey } from '../i18n/translate';
import { ThreeCardShowdownGame, MAX_ANTE, MIN_ANTE } from './game';
import type { ThreeCardShowdownRoundResult, ThreeCardWagerErrorCode } from './types';

const ANTE_ERROR_KEYS: Record<
	ThreeCardWagerErrorCode,
	MessageKey<typeof THREE_CARD_SHOWDOWN_MESSAGES>
> = {
	'invalid-limits': 'errorInvalidLimits',
	'invalid-range': 'errorInvalidRange',
	'out-of-range': 'errorOutOfRange',
	'whole-number-required': 'errorWholeNumber',
	'insufficient-balance': 'errorInsufficientBalance',
};

function rankLabel(rank: Card['rank']): string {
	if (rank === 11) return 'J';
	if (rank === 12) return 'Q';
	if (rank === 13) return 'K';
	if (rank === 14) return 'A';
	return String(rank);
}

function resultText(
	t: ReturnType<typeof threeCardShowdownTranslator>,
	locale: Locale,
	result: ThreeCardShowdownRoundResult,
): string {
	switch (result.outcome) {
		case 'fold':
			return t('resultFold', { net: formatThreeCardShowdownNet(locale, -result.ante) });
		case 'dealer-not-qualified':
			return t('resultDealerNotQualified', {
				net: formatThreeCardShowdownNet(locale, result.ante),
			});
		case 'player-win':
			return t('resultPlayerWin', {
				net: formatThreeCardShowdownNet(locale, result.netDelta),
			});
		case 'tie':
			return t('resultTie', { net: formatThreeCardShowdownNet(locale, 0) });
		case 'dealer-win':
			return t('resultDealerWin', {
				net: formatThreeCardShowdownNet(locale, result.netDelta),
			});
	}
}

function anteErrorText(
	t: ReturnType<typeof threeCardShowdownTranslator>,
	locale: Locale,
	code: ThreeCardWagerErrorCode,
): string {
	if (code === 'out-of-range') {
		return t('errorOutOfRange', {
			min: formatChips(MIN_ANTE, locale),
			max: formatChips(MAX_ANTE, locale),
		});
	}
	return t(ANTE_ERROR_KEYS[code]);
}

/**
 * Browser composition for the Three-Card Showdown route: owns the game
 * instance, the ante/deal/decision interactions, and the guest/authenticated
 * settlement wiring through the shared wallet controller. Guests stay local;
 * authenticated rounds settle through {@link createPublicGameSettlementController}.
 */
export function initThreeCardShowdownClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('three-card-showdown-root');
	if (!root) return;

	const locale = getDocumentLocale(root.ownerDocument);
	const t = threeCardShowdownTranslator(locale);

	const statusEl = document.getElementById('three-card-showdown-status');
	const resultEl = document.getElementById('three-card-showdown-result');
	const dealBtn = document.getElementById('three-card-showdown-deal') as HTMLButtonElement | null;
	const foldBtn = document.getElementById('three-card-showdown-fold') as HTMLButtonElement | null;
	const playBtn = document.getElementById('three-card-showdown-play') as HTMLButtonElement | null;
	const newRoundBtn = document.getElementById(
		'three-card-showdown-new-round',
	) as HTMLButtonElement | null;
	const recoveryHost = document.getElementById('three-card-showdown-recovery-host');
	const anteButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-ante]')];
	const dealerSlots = [0, 1, 2].map((i) =>
		document.getElementById(`three-card-showdown-dealer-slot-${i}`),
	);
	const playerSlots = [0, 1, 2].map((i) =>
		document.getElementById(`three-card-showdown-player-slot-${i}`),
	);

	let anteMessage: string | null = null;

	function render(): void {
		const state = game.getState();
		settlement.syncBalance(state.balance);

		const showDealerCards = state.phase === 'complete';
		for (let i = 0; i < dealerSlots.length; i += 1) {
			const slot = dealerSlots[i];
			if (!slot) continue;
			if (state.phase === 'betting') {
				setSlotState(slot, 'placeholder');
			} else if (state.phase === 'decision') {
				setSlotState(slot, 'facedown');
			} else {
				const card = showDealerCards ? state.dealerHand[i] : undefined;
				if (card) setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
			}
		}

		for (let i = 0; i < playerSlots.length; i += 1) {
			const slot = playerSlots[i];
			if (!slot) continue;
			const card = state.phase === 'betting' ? undefined : state.playerHand[i];
			if (card) setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
			else setSlotState(slot, 'placeholder');
		}

		for (const button of anteButtons) {
			const ante = Number(button.dataset.ante);
			button.setAttribute('aria-pressed', String(ante === state.ante));
			button.disabled = state.phase !== 'betting';
		}

		if (dealBtn) dealBtn.hidden = state.phase !== 'betting';
		if (foldBtn) foldBtn.hidden = state.phase !== 'decision';
		if (playBtn) playBtn.hidden = state.phase !== 'decision';
		if (newRoundBtn) {
			newRoundBtn.hidden = state.phase !== 'complete';
			newRoundBtn.disabled = settlement.isBlocked;
		}

		if (resultEl) {
			resultEl.textContent = state.result ? resultText(t, locale, state.result) : '';
		}

		if (statusEl) {
			if (settlement.statusMessage) {
				statusEl.textContent = settlement.statusMessage;
			} else if (anteMessage) {
				statusEl.textContent = anteMessage;
			} else if (state.phase === 'betting') {
				statusEl.textContent = t('chooseAnte');
			} else if (state.phase === 'decision') {
				statusEl.textContent = t('dealt');
			} else {
				statusEl.textContent = t('roundComplete');
			}
		}
	}

	const settlement = createPublicGameSettlementController({
		gameKey: 'three-card-showdown',
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
			anteMessage = null;
		},
	});

	const game = new ThreeCardShowdownGame(settlement.startingBalance);

	for (const button of anteButtons) {
		button.addEventListener('click', () => {
			if (game.getState().phase !== 'betting') return;
			const ante = Number(button.dataset.ante);
			const error = game.getAnteError(ante);
			if (error) {
				anteMessage = anteErrorText(t, locale, error);
				render();
				return;
			}
			game.setAnte(ante);
			anteMessage = null;
			render();
		});
	}

	dealBtn?.addEventListener('click', () => {
		if (game.getState().phase !== 'betting') return;
		const error = game.getAnteError(game.getState().ante);
		if (error) {
			anteMessage = anteErrorText(t, locale, error);
			render();
			return;
		}
		game.deal();
		anteMessage = null;
		render();
	});

	async function completeDecision(action: 'fold' | 'play'): Promise<void> {
		const round = action === 'fold' ? game.fold() : game.play();
		render(); // reveal dealer and show local result immediately
		await settlement.completeRound(round.netDelta, game.getState().balance);
		render();
	}

	foldBtn?.addEventListener('click', () => {
		if (game.getState().phase !== 'decision') return;
		void completeDecision('fold');
	});

	playBtn?.addEventListener('click', () => {
		if (game.getState().phase !== 'decision') return;
		void completeDecision('play');
	});

	newRoundBtn?.addEventListener('click', () => {
		if (settlement.isBlocked) return;
		game.resetRound();
		anteMessage = null;
		render();
	});

	render();
}
