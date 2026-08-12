import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';
import {
	createSettlementGate,
	newSettlementId,
	type SettlementGate,
	type SettleRoundCommand,
	type SettleRoundResult,
} from '../wallet';
import { MAX_SPOTS, MIN_SPOTS } from './constants';
import { GameSettingsManager } from './GameSettingsManager';
import { KenoGame } from './KenoGame';
import { KenoUIRenderer } from './KenoUIRenderer';
import type { DrawResult } from './types';

const GAME_KEY = 'keno';

/** Build the one wallet command produced by a completed Keno draw. */
export function buildKenoSettlementCommand(
	settlementId: string,
	draw: Pick<DrawResult, 'netDelta'>,
): SettleRoundCommand {
	return {
		settlementId,
		game: 'keno',
		delta: draw.netDelta,
		stats: {
			rounds: 1,
			wins: draw.netDelta > 0 ? 1 : 0,
			losses: draw.netDelta < 0 ? 1 : 0,
			biggestWin: Math.max(draw.netDelta, 0),
		},
	};
}

/** Keep guest play local while blocking authenticated draws behind the gate. */
export function canStartKenoDraw({
	isGuestMode,
	gate,
}: {
	isGuestMode: boolean;
	gate: Pick<SettlementGate, 'isBlocked'>;
}): boolean {
	return isGuestMode || !gate.isBlocked;
}

/** Delegate recovery to the shared settlement gate. */
export function retryKenoSettlement(
	gate: Pick<SettlementGate, 'retry'>,
): Promise<SettleRoundResult | null> {
	return gate.retry();
}

export function initKenoClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('keno-root');
	if (!root) return;

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const isGuestMode = isGuestModeValue(root.dataset.guestMode ?? 'false');
	const initialBalance = Number(root.dataset.initialBalance ?? '1000');
	const syncChips = shouldSyncAccountChips({ isGuestMode });
	const settings = new GameSettingsManager(clientUserId);
	const renderer = new KenoUIRenderer(root);
	const settlementGate = createSettlementGate();
	let serverSyncedBalance = isGuestMode
		? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
		: initialBalance;
	let drawInFlight = false;
	let lastTicketPicks: number[] = [];

	const canDrawNow = () =>
		!drawInFlight && game.canDraw() && canStartKenoDraw({ isGuestMode, gate: settlementGate });

	const game = new KenoGame(serverSyncedBalance, settings.getSettings(), {
		onBalanceUpdate: (balance) => {
			renderer.renderBalance(balance);
			renderer.renderCanDraw(canDrawNow());
			if (isGuestMode) persistGuestBankroll(GAME_KEY, clientUserId, balance);
		},
		onSelectionChange: (picks) => {
			renderer.renderPicks(picks);
			if (picks.length >= MIN_SPOTS) renderer.renderPaytable(picks.length);
			else renderer.clearPaytable();
			renderer.renderCanDraw(canDrawNow());
		},
		onError: (e) => toast(e.message),
		onRoundComplete: () => {
			/* no-op: settlement happens after the reveal animation */
		},
	});

	// The existing banner is kept as a small, hidden recovery surface so the
	// page markup remains stable. It is shown only for a failed wallet
	// settlement and offers the shared gate's Retry/Reset actions.
	const settlementRecovery = (() => {
		const container = document.getElementById('settlement-paused-banner');
		const retry = document.getElementById('btn-retry-settlement') as HTMLButtonElement | null;
		if (!container || !retry) return { container: null, retry: null, reset: null };

		const message = container.querySelector('p');
		if (message) message.textContent = 'Settlement needs attention.';
		let reset = document.getElementById('btn-reset-settlement') as HTMLButtonElement | null;
		if (!reset && typeof document.createElement === 'function') {
			reset = document.createElement('button');
			reset.id = 'btn-reset-settlement';
			reset.type = 'button';
			reset.className = 'deco-btn px-4 py-2 text-sm font-bold rounded-lg';
			reset.textContent = 'Reset round';
			container.appendChild(reset);
		}
		return { container, retry, reset };
	})();

	const showSettlementRecovery = (message: string) => {
		const messageEl = settlementRecovery.container?.querySelector('p');
		if (messageEl) messageEl.textContent = message;
		renderer.setStatus(message);
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

	const settleAuthenticatedDraw = async (draw: DrawResult): Promise<void> => {
		try {
			const result = await settlementGate.settle(buildKenoSettlementCommand(draw.syncId, draw));
			adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Keno settlement failed:', error);
			showSettlementRecovery('Settlement failed. Retry or reset before starting another draw.');
		}
	};

	settlementRecovery.retry?.addEventListener('click', async () => {
		if (!settlementGate.pending) return;
		if (settlementRecovery.retry) settlementRecovery.retry.disabled = true;
		renderer.setStatus('Retrying settlement...');
		try {
			const result = await retryKenoSettlement(settlementGate);
			if (result) adoptSettlementResult(result);
		} catch (error) {
			console.error('[WALLET_SETTLEMENT] Keno settlement retry failed:', error);
			showSettlementRecovery(
				'Settlement failed again. Retry or reset before starting another draw.',
			);
		} finally {
			if (settlementRecovery.retry) settlementRecovery.retry.disabled = false;
		}
	});

	settlementRecovery.reset?.addEventListener('click', () => {
		settlementGate.reset();
		game.setBalance(serverSyncedBalance);
		hideSettlementRecovery();
		renderer.setStatus('Settlement reset. Pick numbers to start.');
		renderer.renderCanDraw(canDrawNow());
	});

	// Initial render
	renderer.renderBalance(game.getBalance());
	renderer.renderBet(game.getBet());
	renderer.renderPicks(game.getPicks());
	renderer.renderCanDraw(canDrawNow());
	renderer.renderSettingsSpeed(settings.getSettings().animationSpeed);

	// Settings modal
	renderer.getSettingsButton().addEventListener('click', () => {
		renderer.showSettingsModal();
	});
	renderer.getSettingsCloseButton().addEventListener('click', () => {
		renderer.hideSettingsModal();
	});
	renderer.getSpeedOptions().forEach((opt) => {
		opt.addEventListener('click', () => {
			const speed = opt.dataset.speed;
			if (speed !== 'slow' && speed !== 'normal' && speed !== 'fast') return;
			settings.setSetting('animationSpeed', speed);
			renderer.renderSettingsSpeed(speed);
		});
	});
	const settingsModal = root.querySelector<HTMLElement>('[data-testid="settings-modal"]');
	if (settingsModal) {
		settingsModal.addEventListener('click', (e) => {
			if (e.target === settingsModal) renderer.hideSettingsModal();
		});
	}

	// Paytable modal
	renderer.getPaytableButton().addEventListener('click', () => {
		renderer.showPaytableModal();
	});
	renderer.getPaytableCloseButton().addEventListener('click', () => {
		renderer.hidePaytableModal();
	});
	const paytableModal = root.querySelector<HTMLElement>('[data-testid="paytable-modal"]');
	if (paytableModal) {
		paytableModal.addEventListener('click', (e) => {
			if (e.target === paytableModal) renderer.hidePaytableModal();
		});
	}

	// Grid: click an empty cell to add, click a selected cell to remove
	renderer.getAllCells().forEach((cell) => {
		cell.addEventListener('click', () => {
			if (drawInFlight) return;
			const n = Number(cell.dataset.number);
			if (cell.classList.contains('selected')) {
				game.removePick(n);
			} else {
				if (game.getPicks().length >= MAX_SPOTS) return;
				game.togglePick(n);
			}
		});
	});

	// Bet chips
	root.querySelectorAll<HTMLButtonElement>('.bet-chip').forEach((btn) => {
		btn.addEventListener('click', () => {
			if (drawInFlight) return;
			const amount = Number(btn.dataset.bet);
			game.setBet(amount);
			renderer.renderBet(amount);
		});
	});

	// Quick Pick (default 8 if no picks)
	renderer.getQuickPickButton().addEventListener('click', () => {
		if (drawInFlight) return;
		const count = game.getPicks().length || 8;
		game.quickPick(count);
	});

	// Clear
	renderer.getClearButton().addEventListener('click', () => {
		if (drawInFlight) return;
		game.clearSelection();
	});

	// Repeat Ticket
	renderer.getRepeatButton().addEventListener('click', () => {
		if (drawInFlight) return;
		if (lastTicketPicks.length === 0) return;
		game.clearSelection();
		[...lastTicketPicks].sort((a, b) => a - b).forEach((n) => game.togglePick(n));
	});

	// Draw
	renderer.getDrawButton().addEventListener('click', () => {
		void commitDraw();
	});

	async function commitDraw(): Promise<void> {
		if (drawInFlight) return;
		if (!canDrawNow()) {
			if (!canStartKenoDraw({ isGuestMode, gate: settlementGate })) {
				showSettlementRecovery(
					'Settlement is still pending. Retry or reset before starting another draw.',
				);
			}
			return;
		}
		drawInFlight = true;
		renderer.getDrawButton().disabled = true;
		renderer.setStatus('Drawing…');
		renderer.clearDrawnHighlight();
		try {
			const settlementId = newSettlementId('keno');
			const result = game.draw(settlementId);
			lastTicketPicks = [...result.picks];
			renderer.renderPicks(game.getPicks());
			renderer.highlightDrawn(result.drawn, result.hits, settings.getRevealStagger());
			await sleep(settings.getAnimationDelay());
			renderer.renderLastResult(result);
			renderer.renderRecent(game.getHistory());
			renderer.setStatus(result.outcome === 'win' ? 'Round complete — win!' : 'Round complete');

			if (syncChips) {
				await settleAuthenticatedDraw(result);
			} else {
				serverSyncedBalance = game.getBalance();
			}
		} catch (err) {
			if (!(err instanceof Error && (err as Error & { code?: string }).code)) {
				console.error('keno: commitDraw failed', err);
			}
			renderer.setStatus('');
		} finally {
			drawInFlight = false;
			renderer.renderCanDraw(canDrawNow());
		}
	}
}

function toast(message: string): void {
	const el = document.getElementById('achievement-toast');
	if (!el) return;
	el.textContent = message;
	el.classList.remove('hidden');
	window.setTimeout(() => el.classList.add('hidden'), 2500);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
