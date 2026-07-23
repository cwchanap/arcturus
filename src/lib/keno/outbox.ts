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
	maxRebases?: number; // default 3
	maxNetworkRetries?: number; // default 3
	sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_REBASES = 3;
const DEFAULT_NETWORK_RETRIES = 3;

export class KenoSyncOutbox {
	private queue: PendingReceipt[];
	private draining = false;
	private readonly deps: OutboxDeps;
	private readonly maxRebases: number;
	private readonly maxNetworkRetries: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(deps: OutboxDeps) {
		this.deps = deps;
		this.queue = deps.load();
		this.maxRebases = deps.maxRebases ?? DEFAULT_REBASES;
		this.maxNetworkRetries = deps.maxNetworkRetries ?? DEFAULT_NETWORK_RETRIES;
		this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	}

	// Resume drain of persisted receipts from a prior tab close.
	// Returns the number of receipts consumed (synced or terminal-dropped).
	async drainPersisted(): Promise<number> {
		if (this.draining) return 0;
		return this.drain();
	}

	// Enqueue one receipt and drain the queue serially to completion.
	async enqueueAndDrain(receipt: PendingReceipt): Promise<void> {
		this.queue.push(receipt);
		this.deps.persist(this.queue);
		if (this.draining) return; // an in-flight drain will pick it up
		await this.drain();
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
				this.deps.setServerSyncedBalance(balance);
				this.dropHead();
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
				const serverBalance = num(body, 'currentBalance');
				this.queue[0] = { ...receipt, previousBalance: serverBalance };
				this.deps.setServerSyncedBalance(serverBalance);
				this.deps.persist(this.queue);
				continue;
			}
			if (res.status === 409 && code === 'MP_ESCROW_ACTIVE') {
				// No currentBalance in chips/update.ts. Refetch handled by caller (pause).
				this.deps.onToast('Chip sync paused: multiplayer hand in progress.');
				return false;
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
			// Any other 4xx → terminal
			this.terminalDrop(body, code || `HTTP_${res.status}`);
			return true;
		}
	}

	private terminalDrop(body: Record<string, unknown>, code: string): void {
		const cur = body['currentBalance'];
		if (typeof cur === 'number') {
			this.deps.setServerSyncedBalance(cur);
			this.deps.setGameBalance(cur);
		}
		this.dropHead();
		this.deps.onHardError(code);
	}

	private dropHead(): void {
		this.queue.shift();
		this.deps.persist(this.queue);
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

function num(b: Record<string, unknown>, k: string): number {
	const v = b[k];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function str(b: Record<string, unknown>, k: string): string {
	return typeof b[k] === 'string' ? (b[k] as string) : '';
}
