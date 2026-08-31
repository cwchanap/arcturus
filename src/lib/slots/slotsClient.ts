import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';
import { getDocumentLocale } from '../i18n/locale';
import { slotsTranslator } from '../i18n/messages/slots';
import { MAX_BET, MIN_BET } from './constants';
import { GameSettingsManager } from './GameSettingsManager';
import { SlotsGame } from './SlotsGame';
import { SlotsUIRenderer } from './SlotsUIRenderer';
import type { SpinResult } from './types';
import {
	createSettlementGate,
	ensureSettlementRecoveryControls,
	newSettlementId,
	type SettlementGate,
	type SettleRoundCommand,
	type SettleRoundResult,
} from '../wallet';

/** Build the one wallet command produced by a completed Slots spin. */
export function buildSlotsSettlementCommand(
	settlementId: string,
	spin: Pick<SpinResult, 'netDelta'>,
): SettleRoundCommand {
	return {
		settlementId,
		game: 'slots',
		delta: spin.netDelta,
		stats: {
			rounds: 1,
			wins: spin.netDelta > 0 ? 1 : 0,
			losses: spin.netDelta < 0 ? 1 : 0,
			biggestWin: Math.max(spin.netDelta, 0),
		},
	};
}

/** Keep guest play local while blocking authenticated spins behind the gate. */
export function canStartSlotsSpin({
	isGuestMode,
	gate,
}: {
	isGuestMode: boolean;
	gate: Pick<SettlementGate, 'isBlocked'>;
}): boolean {
	return isGuestMode || !gate.isBlocked;
}

/** Delegate recovery to the shared settlement gate. */
export function retrySlotsSettlement(
	gate: Pick<SettlementGate, 'retry'>,
): Promise<SettleRoundResult | null> {
	return gate.retry();
}

export function initSlotsClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('slots-root');
	if (!root) return;

	const locale = getDocumentLocale(root.ownerDocument);
	const t = slotsTranslator(locale);

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const isGuest = isGuestModeValue(root.dataset.guestMode ?? 'false');
	const syncToServer = shouldSyncAccountChips({ isGuestMode: isGuest });

	const settingsMgr = new GameSettingsManager(clientUserId);
	const renderer = new SlotsUIRenderer();

	const fallback = Number(root.dataset.initialBalance) || 0;
	const initialBalance = isGuest ? loadGuestBankroll('slots', clientUserId, fallback) : fallback;
	const settlementGate = createSettlementGate();
	let serverSyncedBalance = initialBalance;
	let spinInFlight = false;

	const game = new SlotsGame(initialBalance, settingsMgr.getSettings(), {
		onBalanceUpdate: (balance) => {
			renderer.renderBalance(balance);
			if (!syncToServer) persistGuestBankroll('slots', clientUserId, balance);
			if (typeof updateSpinEnabled === 'function') updateSpinEnabled();
		},
		onRoundComplete: (result) => handleRoundCompleteSafe(result),
		onError: (_err) => {
			// The game only reports invariant failures here (the UI guards every
			// reachable state), so surface the translated generic message rather
			// than English exception copy.
			renderer.showStatus(t('insufficientChips'));
			updateSpinEnabled();
		},
	});

	// Recovery controls stay hidden during normal play and appear only when a
	// wallet settlement needs user action. The shared gate owns the pending
	// command and retry behavior; the client only renders its state.
	const settlementRecovery = ensureSettlementRecoveryControls({
		containerClass: 'hidden mt-3 flex flex-wrap justify-center gap-2',
		retryClass: 'btn-gold px-4 py-2 rounded-lg font-bold',
		retryLabel: t('retrySettlement'),
		resetClass: 'px-4 py-2 rounded-lg border border-[var(--deco-line)]',
		resetLabel: t('resetRound'),
		attachTo: document.getElementById('game-status')?.parentElement ?? null,
	});

	const showSettlementRecovery = (message: string) => {
		renderer.showStatus(message);
		settlementRecovery.container?.classList.remove('hidden');
	};
	const hideSettlementRecovery = () => {
		settlementRecovery.container?.classList.add('hidden');
	};

	const adoptSettlementResult = (result: SettleRoundResult) => {
		serverSyncedBalance = result.balance;
		game.setBalance(result.balance);
		hideSettlementRecovery();
		if (result.newAchievements && result.newAchievements.length > 0) {
			window.dispatchEvent(
				new CustomEvent('achievement-earned', {
					detail: { achievements: result.newAchievements },
				}),
			);
		}
	};

	const settleAuthenticatedSpin = async (spin: SpinResult): Promise<void> => {
		try {
			const result = await settlementGate.settle(buildSlotsSettlementCommand(spin.syncId, spin));
			adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Slots settlement failed:', error);
			showSettlementRecovery(t('settlementFailed'));
		}
	};

	settlementRecovery.retry?.addEventListener('click', async () => {
		if (!settlementGate.pending) return;
		if (settlementRecovery.retry) settlementRecovery.retry.disabled = true;
		renderer.showStatus(t('retryingSettlement'));
		try {
			const result = await retrySlotsSettlement(settlementGate);
			if (result) adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Slots settlement retry failed:', error);
			showSettlementRecovery(t('settlementRetryFailed'));
		} finally {
			if (settlementRecovery.retry) settlementRecovery.retry.disabled = false;
		}
	});

	settlementRecovery.reset?.addEventListener('click', () => {
		settlementGate.reset();
		game.setBalance(serverSyncedBalance);
		hideSettlementRecovery();
		renderer.showStatus(t('settlementReset'));
		updateSpinEnabled();
	});

	renderer.renderBalance(game.getBalance());
	renderer.renderBet(game.getBet());
	updateSpinEnabled();

	function selectBet(amount: number): void {
		// Freeze bet while a spin is in-flight. The spin reads game.bet at
		// reveal time (deferred via setTimeout for non-quick spins), so
		// allowing a bet change between click and reveal would settle the
		// already-started spin for a different stake than the player saw.
		if (spinInFlight) return;
		const clamped = Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)));
		try {
			game.setBet(clamped);
			renderer.renderBet(clamped);
			updateSpinEnabled();
		} catch (_e) {
			// ignore invalid selection
		}
	}

	document.querySelectorAll<HTMLButtonElement>('.bet-chip').forEach((chip) => {
		chip.addEventListener('click', () => selectBet(Number(chip.dataset.bet)));
	});

	const spinBtn = document.getElementById('btn-spin') as HTMLButtonElement | null;
	spinBtn?.addEventListener('click', () => doSpin());

	function updateSpinEnabled(): void {
		renderer.setSpinEnabled(
			!spinInFlight &&
				game.canSpin() &&
				canStartSlotsSpin({ isGuestMode: isGuest, gate: settlementGate }),
		);
	}

	function doSpin(): void {
		if (spinInFlight) {
			renderer.showStatus(t('spinning'));
			return;
		}
		if (!canStartSlotsSpin({ isGuestMode: isGuest, gate: settlementGate })) {
			showSettlementRecovery(t('settlementPending'));
			return;
		}
		if (!game.canSpin()) {
			renderer.showStatus(t('insufficientChips'));
			return;
		}
		spinInFlight = true;
		const settlementId = newSettlementId('slots');
		renderer.setSpinEnabled(false);
		renderer.clearHighlight();
		renderer.showStatus(t('spinning'));
		renderer.setSpinning(true);

		const quickSpin = settingsMgr.getSettings().quickSpin;
		const reveal = () => {
			try {
				const result = game.spin(settlementId);
				renderer.renderGrid(result.grid);
				if (result.lineWins.length > 0) renderer.highlightWins(result.lineWins);
				renderer.renderResult(result);
				renderer.showStatus(null);
				renderer.renderRecent(game.getHistory());
			} finally {
				renderer.setSpinning(false);
				spinInFlight = false;
				updateSpinEnabled();
			}
		};

		if (quickSpin) {
			reveal();
		} else {
			window.setTimeout(reveal, renderer.getSpinDurationMs(settingsMgr.getSettings()));
		}
	}

	async function handleRoundComplete(result: SpinResult): Promise<void> {
		if (!syncToServer) return;
		await settleAuthenticatedSpin(result);
	}

	// onRoundComplete is typed as void (fire-and-forget), so rejections from
	// the async handler would become unhandled Promise rejections. Catch here
	// to prevent silent chip-economy failures from crashing the page.
	function handleRoundCompleteSafe(result: SpinResult): void {
		handleRoundComplete(result).catch((e) => {
			console.error('[slots] wallet settlement failed:', e);
		});
	}

	// Settings panel wiring
	const settingsPanel = document.getElementById('settings-panel');
	document.getElementById('btn-settings')?.addEventListener('click', () => {
		settingsPanel?.classList.remove('hidden');
		applySettingsToUi();
	});
	document.querySelector('.btn-settings-close')?.addEventListener('click', () => {
		settingsPanel?.classList.add('hidden');
	});
	const speedSelect = document.getElementById('setting-spin-speed') as HTMLSelectElement | null;
	speedSelect?.addEventListener('change', () => {
		settingsMgr.updateSettings({ spinSpeed: speedSelect.value as 'slow' | 'normal' | 'fast' });
	});
	document.getElementById('setting-sound')?.addEventListener('change', (e) => {
		settingsMgr.updateSettings({ soundEnabled: (e.target as HTMLInputElement).checked });
	});
	document.getElementById('setting-quick')?.addEventListener('change', (e) => {
		settingsMgr.updateSettings({ quickSpin: (e.target as HTMLInputElement).checked });
	});
	function applySettingsToUi(): void {
		const s = settingsMgr.getSettings();
		if (speedSelect) speedSelect.value = s.spinSpeed;
		const sound = document.getElementById('setting-sound') as HTMLInputElement | null;
		if (sound) sound.checked = s.soundEnabled;
		const quick = document.getElementById('setting-quick') as HTMLInputElement | null;
		if (quick) quick.checked = s.quickSpin;
	}

	// Paytable panel wiring
	const paytablePanel = document.getElementById('paytable-panel');
	document.getElementById('btn-paytable')?.addEventListener('click', () => {
		paytablePanel?.classList.remove('hidden');
	});
	document.querySelector('.btn-paytable-close')?.addEventListener('click', () => {
		paytablePanel?.classList.add('hidden');
	});

	function isAnyModalOpen(): boolean {
		return (
			!paytablePanel?.classList.contains('hidden') || !settingsPanel?.classList.contains('hidden')
		);
	}

	// Keyboard: Escape closes modals; Space/Enter spins (but not behind modals)
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			if (!paytablePanel?.classList.contains('hidden')) {
				paytablePanel?.classList.add('hidden');
				return;
			}
			if (!settingsPanel?.classList.contains('hidden')) {
				settingsPanel?.classList.add('hidden');
				return;
			}
		}
		if ((e.key === ' ' || e.key === 'Enter') && game.canSpin()) {
			if (isAnyModalOpen()) return;
			const target = e.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'BUTTON')
				return;
			e.preventDefault();
			doSpin();
		}
	});
}
