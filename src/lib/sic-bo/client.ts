import { createPublicGameSettlementController } from '../wallet';
import { SicBoGame } from './game';
import { SIC_BO_CHIP_DENOMINATIONS } from './rules';
import type { SicBoBetKey, SicBoRoundResult } from './types';

/**
 * Browser composition for the Sic Bo route: owns the game instance, the bet
 * slip interactions, and the guest/authenticated settlement wiring. Guests
 * stay local; authenticated rolls settle through the shared wallet controller.
 */
export function initSicBoClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('sic-bo-root');
	if (!root) return;

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
		if (totalStakeEl) totalStakeEl.textContent = `Total stake: ${game.getTotalStake()}`;

		document.querySelectorAll<HTMLElement>('[data-bet-amount]').forEach((el) => {
			const key = el.closest('[data-bet-key]')?.getAttribute('data-bet-key') as SicBoBetKey | null;
			const amount = key ? state.bets[key] : undefined;
			el.textContent = amount ? String(amount) : '';
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
					delta > 0 ? `Won +${delta}` : delta < 0 ? `Lost ${Math.abs(delta)}` : 'Push';
			} else {
				resultEl.textContent = '';
			}
		}

		if (settlement.statusMessage) {
			setStatus(settlement.statusMessage);
		} else if (state.phase === 'betting') {
			setStatus(game.getRollError() ?? 'Place your bets, then roll.');
		} else {
			setStatus('Round complete. Start a new round when ready.');
		}

		if (action) {
			action.textContent = state.phase === 'betting' ? 'Roll' : 'New Round';
			action.disabled =
				(state.phase === 'betting' && game.getRollError() !== null) || settlement.isBlocked;
		}
	}

	const settlement = createPublicGameSettlementController({
		gameKey: 'sic-bo',
		root,
		recoveryHost,
		resetLabel: 'Reset round',
		messages: {
			failed: 'Settlement failed. Retry or reset before rolling again.',
			retrying: 'Retrying settlement...',
			retryFailed: 'Settlement failed again. Retry or reset before rolling again.',
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
			try {
				if (current === selectedDenomination) game.clearBet(key);
				else game.setBet(key, selectedDenomination);
			} catch (error) {
				setStatus(error instanceof Error ? error.message : 'Cannot place that bet');
				return;
			}
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
			let result: SicBoRoundResult;
			try {
				result = game.roll();
			} catch (error) {
				setStatus(error instanceof Error ? error.message : 'Cannot roll');
				return;
			}
			render();

			await settlement.completeRound(result.netDelta, game.getState().balance);
			return;
		}

		if (settlement.isBlocked) return;
		try {
			game.resetRound();
		} catch (error) {
			setStatus(error instanceof Error ? error.message : 'Cannot start a new round');
			return;
		}
		render();
	});

	render();
}
