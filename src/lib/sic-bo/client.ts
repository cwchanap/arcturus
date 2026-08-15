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
import { SicBoGame } from './game';
import { SIC_BO_CHIP_DENOMINATIONS } from './rules';
import type { SicBoBetKey, SicBoRoundResult } from './types';

const GAME_KEY = 'sic-bo';

/**
 * Build a wallet settlement command for one completed Sic Bo round.
 */
export function buildSicBoSettlementCommand(
	settlementId: string,
	result: Pick<SicBoRoundResult, 'netDelta'>,
): SettleRoundCommand {
	return {
		settlementId,
		game: 'sic-bo',
		delta: result.netDelta,
		stats: {
			rounds: 1,
			wins: result.netDelta > 0 ? 1 : 0,
			losses: result.netDelta < 0 ? 1 : 0,
			biggestWin: Math.max(result.netDelta, 0),
		},
	};
}

/**
 * Browser composition for the Sic Bo route: owns the game instance, the bet
 * slip interactions, and the guest/authenticated settlement wiring. Guests
 * stay local; authenticated rolls settle through the shared wallet gate.
 */
export function initSicBoClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('sic-bo-root');
	if (!root) return;

	const balanceEl = document.getElementById('chip-balance');
	const statusEl = document.getElementById('sic-bo-status');
	const totalStakeEl = document.getElementById('sic-bo-total-stake');
	const resultEl = document.getElementById('sic-bo-result');
	const action = document.getElementById('sic-bo-action') as HTMLButtonElement | null;
	const clearBetsBtn = document.getElementById('sic-bo-clear-bets');
	const recoveryHost = document.getElementById('sic-bo-recovery-host');
	const dieCells = [0, 1, 2].map((i) => document.getElementById(`sic-bo-die-${i}`));

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const isGuestMode = isGuestModeValue(root.dataset.guestMode ?? 'false');
	const initialBalance = Number(root.dataset.initialBalance ?? '1000');
	const startingBalance = isGuestMode
		? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
		: initialBalance;

	const game = new SicBoGame(startingBalance);
	const gate = createSettlementGate();
	let serverSyncedBalance = startingBalance;
	let selectedDenomination = SIC_BO_CHIP_DENOMINATIONS[0];
	let settlementMessage: string | null = null;

	function setStatus(message: string): void {
		if (statusEl) statusEl.textContent = message;
	}

	function render(): void {
		const state = game.getState();

		const formattedBalance = state.balance.toLocaleString('en-US');
		if (balanceEl) balanceEl.textContent = formattedBalance;
		// Keep the shared header balance pill in sync alongside the canonical
		// panel balance. CasinoLayout renders [data-chip-balance] for
		// authenticated users; without this it stays at the SSR balance until
		// the next navigation.
		document.querySelectorAll<HTMLElement>('[data-chip-balance]').forEach((el) => {
			el.textContent = `${formattedBalance} chips`;
		});
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

		if (settlementMessage) {
			setStatus(settlementMessage);
		} else if (state.phase === 'betting') {
			setStatus(game.getRollError() ?? 'Place your bets, then roll.');
		} else {
			setStatus('Round complete. Start a new round when ready.');
		}

		if (action) {
			action.textContent = state.phase === 'betting' ? 'Roll' : 'New Round';
			action.disabled =
				(state.phase === 'betting' && game.getRollError() !== null) ||
				(!isGuestMode && gate.isBlocked);
		}
	}

	const recovery = ensureSettlementRecoveryControls({
		attachTo: recoveryHost,
		containerId: 'sic-bo-settlement-recovery',
		retryId: 'sic-bo-retry-settlement',
		resetId: 'sic-bo-reset-settlement',
		containerClass: 'hidden mt-4 flex flex-wrap justify-center gap-3',
		retryLabel: 'Retry settlement',
		resetLabel: 'Reset round',
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
			console.error('[WALLET_SETTLEMENT] Sic Bo retry failed:', error);
			showSettlementRecovery('Settlement failed again. Retry or reset before rolling again.');
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
		render();
	});

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
		const settlementBlocked = !isGuestMode && gate.isBlocked;

		if (state.phase === 'betting') {
			if (settlementBlocked) return;
			let result: SicBoRoundResult;
			try {
				result = game.roll();
			} catch (error) {
				setStatus(error instanceof Error ? error.message : 'Cannot roll');
				return;
			}
			render();

			if (!shouldSyncAccountChips({ isGuestMode })) {
				persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance);
				return;
			}

			try {
				const settlement = gate.settle(
					buildSicBoSettlementCommand(newSettlementId('sic-bo'), result),
				);
				render();
				const settled = await settlement;
				adoptSettlementResult(settled);
			} catch (error) {
				console.error('[WALLET_SETTLEMENT] Sic Bo settlement failed:', error);
				showSettlementRecovery('Settlement failed. Retry or reset before rolling again.');
			}
			render();
			return;
		}

		if (settlementBlocked) return;
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
