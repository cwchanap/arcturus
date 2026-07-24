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

// Heartbeat: each tab writes a timestamp periodically so other tabs can tell
// whether it's still live before absorbing its outbox key. Without this, Tab B
// can absorb Tab A's outbox while Tab A is still active — if Tab A enqueues a
// new receipt after Tab B's scan but before Tab B deletes the key, that receipt
// is lost (item 3 race). A tab is "live" if it heartbeated within STALE_MS.
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_STALE_MS = 15000; // 3x interval — tolerates a missed beat

function heartbeatKey(clientUserId: string, tabId: string): string {
	return `arcturus:keno:heartbeat:${clientUserId}:${tabId}`;
}

function isTabLive(clientUserId: string, tabId: string): boolean {
	try {
		const raw = localStorage.getItem(heartbeatKey(clientUserId, tabId));
		if (!raw) return false;
		const ts = Number(raw);
		return Number.isFinite(ts) && Date.now() - ts < HEARTBEAT_STALE_MS;
	} catch {
		return false;
	}
}

function writeHeartbeat(clientUserId: string, tabId: string): void {
	try {
		localStorage.setItem(heartbeatKey(clientUserId, tabId), String(Date.now()));
	} catch {
		// localStorage may be blocked — heartbeats are best-effort. Without a
		// heartbeat, other tabs will treat this tab as dead and absorb its
		// outbox. That's the pre-heartbeat behavior (acceptable, not worse).
	}
}

// Crypto-strong syncId (matches DrawManager's use of crypto). Falls back to
// Math.random only when crypto.randomUUID is unavailable. Dedup makes any
// collision benign; this is consistency with DrawManager, not a security fix.
function makeSyncId(): string {
	const rand =
		typeof crypto !== 'undefined' && crypto.randomUUID
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2, 10);
	return `keno-${Date.now()}-${rand}`;
}

// Load this tab's receipts plus any orphaned receipts from closed tabs (different
// tabIds). Orphaned keys are deleted and their receipts merged into this tab's
// queue so they get drained. The server's chip_sync_receipt PK (userId+syncId)
// guarantees exact-once even if two live tabs race on the same orphan.
//
// HEARTBEAT GUARD: a key belonging to a tab with a recent heartbeat is NOT
// absorbed or deleted — the tab is still live and may enqueue more receipts
// after our scan. Only keys from dead/stale tabs (no heartbeat or stale) are
// absorbed. This closes the item-3 race where Tab B absorbs Tab A's stale
// snapshot, then Tab A enqueues a new receipt that Tab B's delete drops.
function loadOutbox(clientUserId: string, tabId: string): PendingReceipt[] {
	const prefix = `arcturus:keno:outbox:${clientUserId}:`;
	const myKey = outboxKey(clientUserId, tabId);
	const merged: PendingReceipt[] = [];
	const orphanKeys: string[] = [];
	try {
		// Snapshot matching keys BEFORE removing any. Removing an item while
		// iterating by numeric index shifts subsequent indices, so the entry
		// after a removed orphan is skipped — its receipts would be absent
		// from memory and the next persist could overwrite that key, dropping
		// the settlement. Collecting orphans first and deleting after the
		// scan guarantees every key is visited exactly once.
		const matchingKeys: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && key.startsWith(prefix)) matchingKeys.push(key);
		}
		for (const key of matchingKeys) {
			if (key !== myKey) {
				// Check if the owning tab is still live before touching its key.
				const orphanTabId = key.slice(prefix.length);
				if (isTabLive(clientUserId, orphanTabId)) {
					// Live tab — skip entirely. It may enqueue more receipts
					// after our scan; absorbing a stale copy could lose them.
					continue;
				}
			}
			try {
				const raw = localStorage.getItem(key);
				const parsed = raw ? (JSON.parse(raw) as PendingReceipt[]) : [];
				merged.push(...parsed);
				if (key !== myKey) {
					// Orphan from a dead/stale tab — absorb; delete after the scan.
					orphanKeys.push(key);
				}
			} catch {
				// corrupt entry — remove it after the scan
				orphanKeys.push(key);
			}
		}
		// DURABILITY: persist the merged queue to this tab's key BEFORE deleting
		// orphan source keys. If we delete first and this tab crashes before the
		// outbox's first persistBestEffort (e.g. network retries exhaust and
		// sendHead returns false without persisting), the absorbed receipts are
		// lost permanently — the orphan key is gone and the merged queue lives
		// only in memory.
		if (orphanKeys.length > 0) {
			localStorage.setItem(myKey, JSON.stringify(merged));
		}
		for (const key of orphanKeys) localStorage.removeItem(key);
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

	// Write this tab's heartbeat BEFORE loadOutbox scans so other tabs scanning
	// concurrently see us as live. Update periodically and clean up on unload.
	if (syncChips) {
		writeHeartbeat(clientUserId, tabId);
		try {
			const hbInterval = window.setInterval(
				() => writeHeartbeat(clientUserId, tabId),
				HEARTBEAT_INTERVAL_MS,
			);
			window.addEventListener('beforeunload', () => {
				window.clearInterval(hbInterval);
				try {
					localStorage.removeItem(heartbeatKey(clientUserId, tabId));
				} catch {
					/* best-effort */
				}
			});
		} catch {
			/* window.setInterval may be unavailable in some environments */
		}
	}

	const settings = new GameSettingsManager(clientUserId);
	let serverSyncedBalance = isGuestMode
		? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
		: initialBalance;

	const renderer = new KenoUIRenderer(root);
	let drawInFlight = false;
	let lastTicketPicks: number[] = [];
	// True while persisted receipts are draining on page load. Gameplay is
	// gated (canDraw returns false) so the user can't draw until each receipt
	// is classified as committed or newly applied — preventing double-counting
	// of persisted deltas against the server's current chipBalance.
	let persistedDrainInProgress = false;

	const game = new KenoGame(serverSyncedBalance, settings.getSettings(), {
		onBalanceUpdate: (b) => {
			renderer.renderBalance(b);
			renderer.renderCanDraw(canDrawNow());
			if (isGuestMode) persistGuestBankroll(GAME_KEY, clientUserId, b);
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

	// Gameplay gate: disabled while persisted receipts drain on page load.
	const canDrawNow = () => !persistedDrainInProgress && game.canDraw();

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
				onAuthRequired: () => toast('Sign in required to sync chips. Please re-sign-in.'),
			})
		: null;

	// Resume any persisted receipts from a prior tab close. Do NOT pre-apply
	// persisted deltas to the display — for authenticated users,
	// serverSyncedBalance already reflects the server's current chipBalance,
	// which may already include committed persisted receipts. Adding persisted
	// deltas on top double-counts them. The drain's per-200 reconcile handles
	// the display after each receipt is classified (committed or newly applied).
	// Gameplay is gated until the drain completes or pauses (network stall):
	// on stall, re-enable with the last known serverSyncedBalance (conservative
	// — may be temporarily low if a receipt is uncommitted, but never inflated).
	if (outbox) {
		if (outbox.hasPending()) persistedDrainInProgress = true;
		const finishDrain = () => {
			persistedDrainInProgress = false;
			renderer.renderCanDraw(canDrawNow());
		};
		outbox
			.drainPersisted()
			.then(finishDrain)
			.catch((err) => {
				finishDrain();
				console.error('keno: resume drain failed', err);
			});
	}

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
	// Close modal on overlay click
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
		if (!canDrawNow()) return;
		drawInFlight = true;
		renderer.getDrawButton().disabled = true;
		renderer.setStatus('Drawing…');
		renderer.clearDrawnHighlight();
		try {
			const syncId = makeSyncId();
			const result = game.draw(syncId);
			// game.draw() applied the delta to the display. Tell the outbox so a
			// persisted receipt's 200 firing during the reveal animation doesn't
			// briefly overwrite this delta (it's not yet in the outbox queue).
			// Cleared by enqueueAndDrain() once the receipt is queued, and in the
			// finally block as a safety net.
			if (outbox) outbox.setPendingDelta(result.netDelta);
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
				// Always enqueue a receipt, including push rounds (delta === 0).
				// The chip endpoint records the round via outcome + handCount
				// (handsPlayed increments even when wins/losses/net are zero), so
				// skipping push receipts would lose those rounds from game stats
				// and any achievements derived from handsPlayed. A zero-delta
				// receipt doesn't change the balance (the optimistic-lock UPDATE
				// sets chipBalance to the same value; changes() still matches),
				// but it does insert the receipt row and upsert game_stats.
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
			// Safety net: if we set pendingDelta but never reached
			// enqueueAndDrain (e.g. a non-fail throw after game.draw), clear it
			// so a later reconcile doesn't include a stale pending delta.
			if (outbox) outbox.setPendingDelta(0);
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
