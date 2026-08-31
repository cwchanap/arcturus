import { createPublicGameSettlementController } from '../wallet';
import { getDocumentLocale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import { sicBoTranslator, formatSicBoNet, type SIC_BO_MESSAGES } from '../i18n/messages/sic-bo';
import type { MessageKey } from '../i18n/translate';
import { SicBoGame } from './game';
import { SIC_BO_CHIP_DENOMINATIONS } from './rules';
import type { SicBoBetErrorCode, SicBoBetKey, SicBoRoundResult } from './types';

const BET_ERROR_KEYS: Record<SicBoBetErrorCode, MessageKey<typeof SIC_BO_MESSAGES>> = {
	'unsupported-bet': 'errorUnsupportedBet',
	'bets-locked': 'errorBetsLocked',
	denomination: 'errorDenomination',
	'insufficient-balance': 'errorInsufficientBalance',
	'no-bets': 'errorNoBets',
	'new-round-required': 'errorNewRoundRequired',
};

/**
 * Browser composition for the Sic Bo route: owns the game instance, the bet
 * slip interactions, and the guest/authenticated settlement wiring. Guests
 * stay local; authenticated rolls settle through the shared wallet controller.
 */
export function initSicBoClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('sic-bo-root');
	if (!root) return;

	const locale = getDocumentLocale(root.ownerDocument);
	const t = sicBoTranslator(locale);

	const statusEl = document.getElementById('sic-bo-status');
	const totalStakeEl = document.getElementById('sic-bo-total-stake');
	const resultEl = document.getElementById('sic-bo-result');
	const action = document.getElementById('sic-bo-action') as HTMLButtonElement | null;
	const clearBetsBtn = document.getElementById('sic-bo-clear-bets');
	const recoveryHost = document.getElementById('sic-bo-recovery-host');
	const dieCells = [0, 1, 2].map((i) => document.getElementById(`sic-bo-die-${i}`));

	let selectedDenomination = SIC_BO_CHIP_DENOMINATIONS[0];

	function setStatus(message: string): void {
		if (statusEl) statusEl.textContent = message;
	}

	function render(): void {
		const state = game.getState();
		settlement.syncBalance(state.balance);
		if (totalStakeEl) {
			totalStakeEl.textContent = t('totalStake', {
				amount: formatChips(game.getTotalStake(), locale),
			});
		}

		document.querySelectorAll<HTMLElement>('[data-bet-amount]').forEach((el) => {
			const key = el.closest('[data-bet-key]')?.getAttribute('data-bet-key') as SicBoBetKey | null;
			const amount = key ? state.bets[key] : undefined;
			el.textContent = amount ? formatChips(amount, locale) : '';
		});

		document.querySelectorAll<HTMLButtonElement>('[data-denomination]').forEach((btn) => {
			btn.setAttribute(
				'aria-pressed',
				String(Number(btn.dataset.denomination) === selectedDenomination),
			);
		});

		if (state.result) {
			state.result.roll.forEach((value, i) => {
				const cell = dieCells[i];
				if (!cell) return;
				cell.setAttribute('data-value', String(value));
				cell.textContent = String(value);
			});
		} else {
			dieCells.forEach((cell) => {
				if (!cell) return;
				cell.setAttribute('data-value', '0');
				cell.textContent = '—';
			});
		}

		if (resultEl) {
			if (state.result) {
				const delta = state.result.netDelta;
				resultEl.textContent =
					delta > 0
						? t('won', { net: formatSicBoNet(locale, delta) })
						: delta < 0
							? t('lost', { net: formatSicBoNet(locale, delta) })
							: t('push');
			} else {
				resultEl.textContent = '';
			}
		}

		if (settlement.statusMessage) {
			setStatus(settlement.statusMessage);
		} else if (state.phase === 'betting') {
			const rollError = game.getRollError();
			setStatus(rollError ? t(BET_ERROR_KEYS[rollError]) : t('placeBetsThenRoll'));
		} else {
			setStatus(t('roundComplete'));
		}

		if (action) {
			action.textContent = state.phase === 'betting' ? t('roll') : t('newRound');
			action.disabled =
				(state.phase === 'betting' && game.getRollError() !== null) || settlement.isBlocked;
		}
	}

	const settlement = createPublicGameSettlementController({
		gameKey: 'sic-bo',
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
		},
	});
	const game = new SicBoGame(settlement.startingBalance);

	document.querySelectorAll<HTMLButtonElement>('[data-denomination]').forEach((btn) => {
		btn.addEventListener('click', () => {
			if (game.getState().phase !== 'betting') return;
			selectedDenomination = Number(btn.dataset.denomination);
			render();
		});
	});

	document.querySelectorAll<HTMLButtonElement>('[data-bet-key]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const key = btn.dataset.betKey as SicBoBetKey | undefined;
			if (!key || game.getState().phase !== 'betting') return;
			const current = game.getState().bets[key];
			// Check the code before mutating so the slip stays clean and the
			// translated message comes from the catalog, not an exception.
			const error = game.getBetError(key, selectedDenomination);
			if (error) {
				setStatus(t(BET_ERROR_KEYS[error]));
				return;
			}
			if (current === selectedDenomination) game.clearBet(key);
			else game.setBet(key, selectedDenomination);
			render();
		});
	});

	clearBetsBtn?.addEventListener('click', () => {
		if (game.getState().phase !== 'betting') return;
		game.clearBets();
		render();
	});

	action?.addEventListener('click', async () => {
		const state = game.getState();

		if (state.phase === 'betting') {
			if (settlement.isBlocked) return;
			const rollError = game.getRollError();
			if (rollError) {
				setStatus(t(BET_ERROR_KEYS[rollError]));
				return;
			}
			let result: SicBoRoundResult;
			try {
				result = game.roll();
			} catch (_error) {
				setStatus(t('cannotRoll'));
				return;
			}
			render();

			await settlement.completeRound(result.netDelta, game.getState().balance);
			return;
		}

		if (settlement.isBlocked) return;
		try {
			game.resetRound();
		} catch (_error) {
			setStatus(t('cannotStartNewRound'));
			return;
		}
		render();
	});

	render();
}
