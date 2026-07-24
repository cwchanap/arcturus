// src/lib/keno/outbox.ts
// Serialized FIFO outbox + drain loop for exact-once chip settlement.
// See docs/superpowers/specs/2026-07-21-keno-design.md §Settlement Flow.

import type { KenoOutcome } from './types';

export type PendingReceipt = {
	syncId: string;
	previousBalance: number; // rebased on BALANCE_MISMATCH
	delta: number;
	gameType: 'keno';
	outcome: KenoOutcome;
	handCount: 1;
	biggestWinCandidate: number | undefined;
};

export type FetchResponse = {
	ok: boolean;
	status: number;
	headers: { get: (name: string) => string | null };
	json: () => Promise<Record<string, unknown>>;
};

export type OutboxDeps = {
	fetchImpl: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string },
	) => Promise<FetchResponse>;
	endpoint: string;
	persist: (receipts: PendingReceipt[]) => void;
	load: () => PendingReceipt[];
	setServerSyncedBalance: (balance: number) => void;
	setGameBalance: (balance: number) => void;
	onHardError: (code: string) => void;
	onToast: (message: string) => void;
	// Called on 401/403 — the session is no longer valid. The queue is retained
	// (receipt NOT dropped) and the drain pauses so the receipt can be retried
	// after authentication is restored (e.g. page reload after re-sign-in, or
	// an explicit resume call). Without this, an expired session during a draw
	// permanently discards the chip delta — the 401 response carries no
	// currentBalance, so terminalDrop would delete the receipt without
	// reconciling the display, losing the settlement.
	onAuthRequired?: () => void;
	maxRebases?: number; // default 3
	maxNetworkRetries?: number; // default 3
	maxEscrowRetries?: number; // default 3 — bounded retries while MP escrow holds
	escrowRetryMs?: number; // default 2000 — backoff between escrow retries
	sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_REBASES = 3;
const DEFAULT_NETWORK_RETRIES = 3;
const DEFAULT_ESCROW_RETRIES = 3;
const DEFAULT_ESCROW_RETRY_MS = 2000;

export class KenoSyncOutbox {
	private queue: PendingReceipt[];
	private draining = false;
	// Delta applied to the display by game.draw() but not yet enqueued as a
	// receipt. Included in reconcile() so a persisted receipt's 200 firing
	// during the reveal animation doesn't briefly overwrite the live draw's
	// delta. Cleared by enqueueAndDrain() (the receipt is then in the queue).
	private pendingDelta = 0;
	private readonly deps: OutboxDeps;
	private readonly maxRebases: number;
	private readonly maxNetworkRetries: number;
	private readonly maxEscrowRetries: number;
	private readonly escrowRetryMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(deps: OutboxDeps) {
		this.deps = deps;
		this.queue = deps.load().map((r) => ({ ...r }));
		this.maxRebases = deps.maxRebases ?? DEFAULT_REBASES;
		this.maxNetworkRetries = deps.maxNetworkRetries ?? DEFAULT_NETWORK_RETRIES;
		this.maxEscrowRetries = deps.maxEscrowRetries ?? DEFAULT_ESCROW_RETRIES;
		this.escrowRetryMs = deps.escrowRetryMs ?? DEFAULT_ESCROW_RETRY_MS;
		this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	}

	// True if the outbox has receipts loaded from a prior tab close that haven't
	// been drained yet. The client uses this to gate gameplay only when there
	// are actually persisted receipts to replay (avoiding a needless gate when
	// the outbox is empty on a fresh page load).
	hasPending(): boolean {
		return this.queue.length > 0;
	}

	// Resume drain of persisted receipts from a prior tab close.
	// Returns the number of receipts consumed (synced or terminal-dropped).
	async drainPersisted(): Promise<number> {
		if (this.draining) return 0;
		return this.drain();
	}

	// Track a delta applied to the display by game.draw() but not yet
	// enqueued as a receipt. reconcile() includes it so a persisted receipt's
	// 200 firing during the reveal animation doesn't briefly lose the live
	// draw's delta. Cleared by enqueueAndDrain() once the receipt is queued.
	setPendingDelta(delta: number): void {
		this.pendingDelta = delta;
	}

	// Reconcile the display to serverBalance + sum(unsettled queued deltas).
	// Called by the client after construction to apply persisted receipts'
	// deltas to the display before the drain completes, and internally after
	// every server response (200, rebase, terminal) to keep the display
	// authoritative: display = serverSyncedBalance + unsettled optimistic deltas.
	reconcileDisplay(serverBalance: number): void {
		this.reconcile(serverBalance);
	}

	// Enqueue one receipt and drain the queue serially to completion.
	async enqueueAndDrain(receipt: PendingReceipt): Promise<void> {
		// The receipt's delta is now in the queue — clear the pending delta
		// so reconcile() doesn't double-count it (queue + pendingDelta).
		this.pendingDelta = 0;
		this.queue.push(receipt);
		this.persistBestEffort();
		if (this.draining) return; // an in-flight drain will pick it up
		await this.drain();
	}

	// Persistence is best-effort (crash recovery only). The in-memory queue is
	// the drain source of truth — a thrown persist (e.g. localStorage full or
	// blocked) must NOT abort the drain, or the chip delta is never sent and is
	// not durable. Log and continue; the next successful persist re-syncs state.
	private persistBestEffort(): void {
		try {
			this.deps.persist(this.queue);
		} catch (err) {
			console.error('keno: outbox persist failed (best-effort)', err);
		}
	}

	private async drain(): Promise<number> {
		this.draining = true;
		let drained = 0;
		try {
			while (this.queue.length > 0) {
				const ok = await this.sendHead();
				if (!ok) break; // paused (e.g. MP_ESCROW) or sleeping handled inside sendHead
				drained++;
			}
		} finally {
			this.draining = false;
		}
		return drained;
	}

	// Returns true if the head was consumed (drop or success); false if paused.
	private async sendHead(): Promise<boolean> {
		let rebases = 0;
		let networkRetries = 0;
		let escrowRetries = 0;
		while (true) {
			// Re-read head each iteration: BALANCE_MISMATCH mutates queue[0] in place
			// (previousBalance := server currentBalance) and the next post() must use
			// the rebased payload, not a stale local snapshot.
			const receipt = this.queue[0];
			const res = await this.post(receipt);
			if (res === 'NETWORK_ERROR') {
				networkRetries++;
				if (networkRetries > this.maxNetworkRetries) {
					// leave at head; stop the drain (caller / next page load retries)
					return false;
				}
				await this.sleep(500 * networkRetries);
				continue;
			}
			let body: Record<string, unknown>;
			try {
				body = await res.json();
			} catch {
				// Malformed JSON — treat as transient, retry same head.
				networkRetries++;
				if (networkRetries > this.maxNetworkRetries) return false;
				await this.sleep(500 * networkRetries);
				continue;
			}
			if (res.status === 200) {
				const balance = body['balance'];
				if (typeof balance !== 'number' || !Number.isFinite(balance)) {
					// Malformed 200 — don't adopt 0 as synced balance; retry same head.
					networkRetries++;
					if (networkRetries > this.maxNetworkRetries) return false;
					await this.sleep(500 * networkRetries);
					continue;
				}
				// Drop the settled receipt, then reconcile display to the server's
				// authoritative balance + any still-unsettled queued deltas. Every
				// 200 reconciles, so the display is always serverBalance + sum(remaining
				// queue deltas) — no resumed/live split.
				this.dropHead();
				this.reconcile(balance);
				return true;
			}
			const code = str(body, 'error');
			if (res.status === 409 && code === 'BALANCE_MISMATCH') {
				rebases++;
				if (rebases > this.maxRebases) {
					this.terminalDrop(body, code);
					return true;
				}
				// rebase previousBalance := currentBalance; keep syncId + delta; retry same head.
				// Server's receipt check runs before BALANCE_MISMATCH, so this proves the delta
				// was never applied — safe to retry with the corrected previousBalance.
				// currentBalance MUST be a finite number — rebasing to 0 on a missing field
				// would corrupt serverSyncedBalance and poison the next receipt's
				// previousBalance. Treat a malformed MISMATCH body as terminal.
				const serverBalance = body['currentBalance'];
				if (typeof serverBalance !== 'number' || !Number.isFinite(serverBalance)) {
					this.terminalDrop(body, 'BALANCE_MISMATCH_MISSING_BALANCE');
					return true;
				}
				this.queue[0] = { ...receipt, previousBalance: serverBalance };
				this.persistBestEffort();
				// Reconcile display to the rebased server balance + pending deltas
				// (including this receipt's delta, which is still unsettled).
				this.reconcile(serverBalance);
				continue;
			}
			if (res.status === 409 && code === 'MP_ESCROW_ACTIVE') {
				// Multiplayer escrow is transient (hand in progress). Retry with a bounded
				// backoff so a receipt doesn't stall indefinitely waiting for the next draw
				// or page reload. After exhausting retries, leave at head (return false) —
				// the next enqueueAndDrain / drainPersisted resumes from here.
				escrowRetries++;
				if (escrowRetries > this.maxEscrowRetries) {
					this.deps.onToast('Chip sync paused: multiplayer hand in progress.');
					return false;
				}
				await this.sleep(this.escrowRetryMs);
				continue;
			}
			if (res.status === 409 && code === 'SYNC_ID_REUSE_MISMATCH') {
				this.terminalDrop(body, code);
				return true;
			}
			if (res.status === 429) {
				networkRetries++;
				if (networkRetries > this.maxNetworkRetries) {
					return false;
				}
				const parsedRetryAfter = Number(res.headers.get('Retry-After') ?? '1');
				const retryAfter =
					Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0 ? parsedRetryAfter : 1;
				await this.sleep(retryAfter * 1000);
				continue; // same head, same payload
			}
			// 5xx → transient server failure, retry like a network error.
			if (res.status >= 500) {
				networkRetries++;
				if (networkRetries > this.maxNetworkRetries) {
					return false;
				}
				await this.sleep(500 * networkRetries);
				continue;
			}
			// 401/403 → session expired. The 401 response carries no currentBalance,
			// so terminalDrop would delete the receipt without reconciling the
			// display — permanently losing the chip delta. Instead, retain the
			// receipt at the head, surface an auth-required state, and pause the
			// drain. The receipt is still persisted; a page reload after re-sign-in
			// (or an explicit resume) re-drains it.
			if (res.status === 401 || res.status === 403) {
				this.deps.onAuthRequired?.();
				return false; // pause — leave receipt at head, do NOT drop
			}
			// Any other 4xx → terminal
			this.terminalDrop(body, code || `HTTP_${res.status}`);
			return true;
		}
	}

	private terminalDrop(body: Record<string, unknown>, code: string): void {
		this.dropHead();
		const cur = body['currentBalance'];
		// Reconcile display to the server's currentBalance + any remaining
		// queued deltas (later optimistic receipts still pending). Without this,
		// a terminal drop would overwrite the display with currentBalance and
		// lose later receipts' deltas that were already applied locally.
		if (typeof cur === 'number') {
			this.reconcile(cur);
		}
		this.deps.onHardError(code);
	}

	private dropHead(): void {
		this.queue.shift();
		this.persistBestEffort();
	}

	// Set the authoritative server balance and reconcile the display to
	// serverBalance + sum(unsettled queued deltas). Called after every server
	// response that changes the known server balance (200, rebase, terminal).
	private reconcile(serverBalance: number): void {
		this.deps.setServerSyncedBalance(serverBalance);
		const unsettled = this.queue.reduce((sum, r) => sum + r.delta, 0);
		this.deps.setGameBalance(serverBalance + unsettled + this.pendingDelta);
	}

	private async post(receipt: PendingReceipt): Promise<FetchResponse | 'NETWORK_ERROR'> {
		// 7 fields only — NEVER statsDelta/winsIncrement/lossesIncrement (keno isn't batched).
		const body = JSON.stringify({
			syncId: receipt.syncId,
			previousBalance: receipt.previousBalance,
			delta: receipt.delta,
			gameType: receipt.gameType,
			outcome: receipt.outcome,
			handCount: receipt.handCount,
			biggestWinCandidate: receipt.biggestWinCandidate,
		});
		try {
			return await this.deps.fetchImpl(this.deps.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
			});
		} catch {
			return 'NETWORK_ERROR';
		}
	}
}

function str(b: Record<string, unknown>, k: string): string {
	return typeof b[k] === 'string' ? (b[k] as string) : '';
}
