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
const TAB_ID_KEY = 'arcturus:keno:tab-id';

// Per-tab outbox key. sessionStorage is scoped to a single tab and cleared on
// tab close, so each tab gets a stable uuid for its lifetime and tabs never
// share one outbox key (which would let Tab B's persist clobber Tab A's in-flight
// receipt). Orphaned keys from closed tabs are recovered by loadOutbox's scan.
function getTabId(): string {
	try {
		const existing = sessionStorage.getItem(TAB_ID_KEY);
		if (existing) return existing;
		const id =
			typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		sessionStorage.setItem(TAB_ID_KEY, id);
		return id;
	} catch {
		return 'fallback';
	}
}

function outboxKey(clientUserId: string, tabId: string): string {
	return `arcturus:keno:outbox:${clientUserId}:${tabId}`;
}

// Load this tab's receipts plus any orphaned receipts from closed tabs (different
// tabIds). Orphaned keys are deleted and their receipts merged into this tab's
// queue so they get drained. The server's chip_sync_receipt PK (userId+syncId)
// guarantees exact-once even if two live tabs race on the same orphan.
function loadOutbox(clientUserId: string, tabId: string): PendingReceipt[] {
	const prefix = `arcturus:keno:outbox:${clientUserId}:`;
	const merged: PendingReceipt[] = [];
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(prefix)) continue;
			try {
				const raw = localStorage.getItem(key);
				const parsed = raw ? (JSON.parse(raw) as PendingReceipt[]) : [];
				if (key === outboxKey(clientUserId, tabId)) {
					merged.push(...parsed);
				} else {
					// Orphan from a closed tab — absorb and delete.
					merged.push(...parsed);
					localStorage.removeItem(key);
				}
			} catch {
				// corrupt entry — remove it
				if (key) localStorage.removeItem(key);
			}
		}
	} catch {
		return [];
	}
	return merged;
}

export function initKenoClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('keno-root');
	if (!root) return;

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const tabId = getTabId();
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
			else renderer.clearPaytable();
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
					localStorage.setItem(outboxKey(clientUserId, tabId), JSON.stringify(receipts)),
				load: () => loadOutbox(clientUserId, tabId),
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
	renderer.getSoundCheckbox().addEventListener('change', (e) => {
		settings.setSetting('soundEnabled', (e.target as HTMLInputElement).checked);
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
			const result = game.draw(syncId);
			lastTicketPicks = [...result.picks];
			renderer.renderPicks(game.getPicks());
			// Reveal animation
			renderer.highlightDrawn(result.drawn, result.hits, settings.getRevealStagger());
			await sleep(settings.getAnimationDelay());
			renderer.renderLastResult(result);
			renderer.renderRecent(game.getHistory());
			renderer.setStatus(result.outcome === 'win' ? 'Round complete — win!' : 'Round complete');
			// Enqueue settlement (per-draw delta: net change for THIS draw only).
			// Use result.netDelta (snapshotted at draw time) — NOT game.getBalance() - balanceBefore,
			// because a resumed outbox receipt or terminalDrop may call setGameBalance() during the
			// reveal animation's await, mutating game.getBalance() and inflating the diff.
			if (outbox) {
				const delta = result.netDelta;
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
		} catch (err) {
			// game.draw() throws via fail() which already emitted onError (toast).
			// Swallow to prevent an unhandled rejection from the void commitDraw() call;
			// non-fail throws (programming bugs) still surface via console.error.
			if (!(err instanceof Error && (err as Error & { code?: string }).code)) {
				console.error('keno: commitDraw failed', err);
			}
			// Reset the in-flight status line — fail() toasted the error, but the
			// "Drawing…" label would otherwise stay stuck since the success path
			// that overwrites it never ran.
			renderer.setStatus('');
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
