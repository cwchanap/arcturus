// src/lib/keno/kenoClient.ts
import {
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';
import { MAX_SPOTS, MIN_SPOTS } from './constants';
import { GameSettingsManager } from './GameSettingsManager';
import { KenoGame } from './KenoGame';
import { KenoUIRenderer } from './KenoUIRenderer';
import { KenoSyncOutbox } from './outbox';
import type { PendingReceipt } from './outbox';

const GAME_KEY = 'keno';

function outboxKey(clientUserId: string): string {
	return `arcturus:keno:outbox:${clientUserId}`;
}
function loadOutbox(clientUserId: string): PendingReceipt[] {
	try {
		const raw = localStorage.getItem(outboxKey(clientUserId));
		return raw ? (JSON.parse(raw) as PendingReceipt[]) : [];
	} catch {
		return [];
	}
}

export function initKenoClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('keno-root');
	if (!root) return;

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const isGuestMode = root.dataset.guestMode === 'true';
	const initialBalance = Number(root.dataset.initialBalance ?? '1000');
	const syncChips = shouldSyncAccountChips({ isGuestMode });

	const settings = new GameSettingsManager(clientUserId);
	let serverSyncedBalance = isGuestMode
		? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
		: initialBalance;

	const renderer = new KenoUIRenderer(root);
	let drawInFlight = false;
	let lastTicketPicks: number[] = [];

	const game = new KenoGame(serverSyncedBalance, settings.getSettings(), {
		onBalanceUpdate: (b) => {
			renderer.renderBalance(b);
			renderer.renderCanDraw(game.canDraw());
			if (isGuestMode) persistGuestBankroll(GAME_KEY, clientUserId, b);
		},
		onSelectionChange: (picks) => {
			renderer.renderPicks(picks);
			if (picks.length >= MIN_SPOTS) renderer.renderPaytable(picks.length);
			renderer.renderCanDraw(game.canDraw());
		},
		onError: (e) => toast(e.message),
		onRoundComplete: () => {
			/* no-op: settlement happens after the reveal animation */
		},
	});

	const outbox = syncChips
		? new KenoSyncOutbox({
				fetchImpl: (url, init) =>
					fetch(url, init as RequestInit).then(async (r) => ({
						ok: r.ok,
						status: r.status,
						headers: { get: (k: string) => r.headers.get(k) },
						json: async () => (await r.json()) as Record<string, unknown>,
					})),
				endpoint: '/api/chips/update',
				persist: (receipts) =>
					localStorage.setItem(outboxKey(clientUserId), JSON.stringify(receipts)),
				load: () => loadOutbox(clientUserId),
				setServerSyncedBalance: (b) => (serverSyncedBalance = b),
				setGameBalance: (b) => game.setBalance(b),
				onHardError: (code) => toast(`Sync error: ${code}`),
				onToast: (m) => toast(m),
			})
		: null;

	// Resume any persisted receipts from a prior tab close.
	// Reconcile is per-receipt inside the outbox: resumed receipts call
	// setGameBalance on their 200 path so the display reflects the prior
	// tab's delta. Live-draw 200s do NOT call setGameBalance (the display
	// was already updated locally at draw time).
	if (outbox) {
		outbox.drainPersisted().catch((err) => {
			console.error('keno: resume drain failed', err);
		});
	}

	// Initial render
	renderer.renderBalance(game.getBalance());
	renderer.renderBet(game.getBet());
	renderer.renderPicks(game.getPicks());
	renderer.renderCanDraw(game.canDraw());
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
	// Close modal on overlay click
	const settingsModal = root.querySelector<HTMLElement>('[data-testid="settings-modal"]');
	if (settingsModal) {
		settingsModal.addEventListener('click', (e) => {
			if (e.target === settingsModal) renderer.hideSettingsModal();
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
				if (game.getPicks().length >= MAX_SPOTS) return; // silently ignore
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
		if (!game.canDraw()) return;
		drawInFlight = true;
		renderer.getDrawButton().disabled = true;
		renderer.setStatus('Drawing…');
		renderer.clearDrawnHighlight();
		try {
			const syncId = `keno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const balanceBefore = game.getBalance();
			const result = game.draw(syncId);
			lastTicketPicks = [...result.picks];
			renderer.renderPicks(game.getPicks());
			// Reveal animation
			renderer.highlightDrawn(result.drawn, result.hits);
			await sleep(settings.getAnimationDelay());
			renderer.renderLastResult(result);
			renderer.renderRecent(game.getHistory());
			renderer.setStatus(result.outcome === 'win' ? 'Round complete — win!' : 'Round complete');
			// Enqueue settlement (per-draw delta: net change for THIS draw only)
			if (outbox) {
				const delta = game.getBalance() - balanceBefore;
				const receipt: PendingReceipt = {
					syncId,
					previousBalance: serverSyncedBalance,
					delta,
					gameType: 'keno',
					outcome: result.outcome,
					handCount: 1,
					biggestWinCandidate: delta > 0 ? delta : undefined,
				};
				void outbox.enqueueAndDrain(receipt).catch((err) => {
					console.error('keno: settlement drain failed', err);
				});
			} else {
				// Guest mode: no fetch; serverSyncedBalance tracks the local bankroll.
				serverSyncedBalance = game.getBalance();
			}
		} finally {
			drawInFlight = false;
			renderer.renderCanDraw(game.canDraw());
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
