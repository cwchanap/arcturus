import {
	computeSlotsBatchStats,
	getFollowUpBackoffDelayMs,
	MAX_FOLLOW_UP_ATTEMPTS,
	MAX_SLOTS_SYNC_HANDS_PER_REQUEST,
	resolveSlotsSyncState,
	shouldAbandonFollowUpSync,
	type SlotsPendingStats,
} from './balance-sync-state';
import type { SpinResult } from './types';

export type ChipSyncResponse = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	headers: { get: (name: string) => string | null };
};

export type ChipSyncDeps = {
	fetchImpl: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string },
	) => Promise<ChipSyncResponse>;
	setTimeoutImpl: (fn: () => void | Promise<void>, ms: number) => void;
	getGameBalance: () => number;
	setGameBalance: (balance: number) => void;
	onAchievement: (title: string) => void;
	onRateLimitGiveUp: () => void;
	onNetworkErrorGiveUp: () => void;
	generateSyncRequestId: () => string;
	endpoint: string;
	// Best-effort fire-and-forget transport for unload-time stat flushing.
	// sendBeacon sends cookies (same-origin) so the auth session carries; the
	// response is unavailable, so this is only used to avoid dropping
	// pending win/loss/hand stats when the user closes the tab after a 429
	// give-up. Optional — when absent the give-up just drops pending stats.
	sendBeaconImpl?: (url: string, body: string) => boolean;
};

const RATE_LIMIT_RETRY_CAP_MS = 8000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;

export class ChipSyncCoordinator {
	private serverSyncedBalance: number;
	private isSyncInProgress = false;
	private syncPending = false;
	private pendingRetryTimer = false;
	private followUpAttempts = 0;
	// Per-round net deltas for rounds completed but not yet acknowledged by the
	// server. Source of truth for pending stats — the aggregate (wins/losses/
	// hands/biggestWin) is derived via computeSlotsBatchStats. Tracking per-round
	// allows splitting oversized batches at MAX_SLOTS_SYNC_HANDS_PER_REQUEST so
	// the server never rejects coalesced Quick Spin rounds with INVALID_HAND_COUNT.
	private pendingRoundDeltas: number[] = [];
	private readonly deps: ChipSyncDeps;

	constructor(deps: ChipSyncDeps, initialServerSyncedBalance: number) {
		this.deps = deps;
		this.serverSyncedBalance = initialServerSyncedBalance;
	}

	getServerSyncedBalance(): number {
		return this.serverSyncedBalance;
	}

	getPendingStats(): SlotsPendingStats {
		return computeSlotsBatchStats(this.pendingRoundDeltas);
	}

	isBusy(): boolean {
		return this.isSyncInProgress || this.pendingRetryTimer;
	}

	// Best-effort flush of pending win/loss/hand stats when the user closes
	// the tab or navigates away. Exposed so the client can wire it to the
	// pagehide event. Safe to call even if a sync is in-flight — the in-flight
	// fetch may still settle, but the beacon ensures stats are not lost if it
	// doesn't. No-op when there are no pending stats or no sendBeacon impl.
	flushPendingStatsOnUnload(): void {
		this.flushPendingStatsViaBeacon();
	}

	handleRoundComplete(result: SpinResult): Promise<void> {
		this.pendingRoundDeltas.push(result.netDelta);
		if (this.isBusy()) {
			this.syncPending = true;
			return Promise.resolve();
		}
		return this.runSync();
	}

	async runSync(retryCount = 0): Promise<void> {
		this.pendingRetryTimer = false;
		this.isSyncInProgress = true;
		// No pending rounds means nothing to sync — the balance invariant
		// (gameBalance === serverSyncedBalance + sum(pendingRoundDeltas)) holds
		// by construction, so a zero-length array implies delta 0 as well.
		// A round whose netDelta is 0 (a push) still appears in the array, so
		// the request is sent and the hand is recorded rather than dropped.
		if (this.pendingRoundDeltas.length === 0) {
			this.isSyncInProgress = false;
			return;
		}
		// Cap the batch at the server's per-request hand limit. Rounds beyond
		// the cap remain in pendingRoundDeltas and are synced in a follow-up
		// request after this batch succeeds. The delta sent is the sum of the
		// batch's per-round deltas (not gameBalance - serverSyncedBalance, which
		// includes rounds beyond the batch), so the server applies only this
		// batch's balance change.
		const batchDeltas = this.pendingRoundDeltas.slice(0, MAX_SLOTS_SYNC_HANDS_PER_REQUEST);
		const batchLength = batchDeltas.length;
		const deltaForRequest = batchDeltas.reduce((sum, d) => sum + d, 0);
		const snapshot = computeSlotsBatchStats(batchDeltas);
		const outcome: 'win' | 'loss' | 'push' =
			deltaForRequest > 0 ? 'win' : deltaForRequest < 0 ? 'loss' : 'push';

		try {
			const response = await this.deps.fetchImpl(this.deps.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					delta: deltaForRequest,
					gameType: 'slots',
					previousBalance: this.serverSyncedBalance,
					outcome,
					handCount: snapshot.handsIncrement || 1,
					winsIncrement: snapshot.winsIncrement || undefined,
					lossesIncrement: snapshot.lossesIncrement || undefined,
					biggestWinCandidate: snapshot.biggestWinCandidate,
					syncId: this.deps.generateSyncRequestId(),
				}),
			});
			const data = (await response.json().catch(() => ({}))) as {
				balance?: number;
				// Error responses (DELTA_EXCEEDS_LIMIT, BALANCE_MISMATCH) carry the
				// server's authoritative balance under `currentBalance`, not `balance`.
				// The success path uses `balance`. Read both so the rebase branch runs
				// regardless of which response shape we receive.
				currentBalance?: number;
				previousBalance?: number;
				error?: string;
				newAchievements?: Array<{ name?: string; title?: string }>;
			};

			if (response.ok) {
				// Remove the synced batch. New rounds that arrived during the
				// await were appended after the batch, so they remain pending.
				this.pendingRoundDeltas.splice(0, batchLength);
				if (typeof data.balance === 'number') {
					const remainingDelta = this.pendingRoundDeltas.reduce((sum, d) => sum + d, 0);
					this.serverSyncedBalance = data.balance;
					this.deps.setGameBalance(data.balance + remainingDelta);
				} else {
					// 200 OK without a balance field is an unexpected server response.
					// The balance axis self-heals on the next sync (delta is computed
					// from the remaining pending rounds), but this indicates a
					// server-side issue worth surfacing.
					console.warn('[slots] chip sync returned 200 OK without a balance field');
				}
				if (data.newAchievements?.length) {
					for (const a of data.newAchievements) {
						this.deps.onAchievement(a.title ?? a.name ?? 'Achievement unlocked!');
					}
				}
				this.isSyncInProgress = false;
				// Trigger a follow-up if new rounds arrived during the sync OR if
				// this was a partial batch (remaining rounds from the split).
				if (this.syncPending || this.pendingRoundDeltas.length > 0) {
					this.syncPending = false;
					this.followUpAttempts = 0;
					await this.runSync();
				}
				return;
			}

			if (response.status === 429) {
				if (retryCount >= MAX_FOLLOW_UP_ATTEMPTS) {
					this.isSyncInProgress = false;
					console.warn('[slots] chip sync gave up after 429 rate-limit retries; balance may drift');
					this.flushPendingStatsViaBeacon();
					this.deps.onRateLimitGiveUp();
					return;
				}
				const retryAfter = Number(
					response.headers.get('Retry-After') ?? DEFAULT_RETRY_AFTER_SECONDS,
				);
				this.pendingRetryTimer = true;
				this.deps.setTimeoutImpl(
					() => this.runSync(retryCount + 1),
					Math.min(retryAfter * 1000, RATE_LIMIT_RETRY_CAP_MS),
				);
				return;
			}

			// Error responses carry the server balance as `currentBalance`; the
			// success path uses `balance`. Fall back so both shapes rebase correctly.
			const serverBalanceFromError = data.currentBalance ?? data.balance;
			const resolution = resolveSlotsSyncState({
				error: data.error,
				hasServerBalance: typeof serverBalanceFromError === 'number',
			});
			if (resolution.clearPendingStats) {
				// Server gave an authoritative balance or a non-retriable error —
				// abandon the batch. Concurrent rounds that arrived during the
				// await remain pending in pendingRoundDeltas.
				this.pendingRoundDeltas.splice(0, batchLength);
			}
			if (typeof serverBalanceFromError === 'number') {
				const remainingDelta = this.pendingRoundDeltas.reduce((sum, d) => sum + d, 0);
				this.serverSyncedBalance = serverBalanceFromError;
				this.deps.setGameBalance(serverBalanceFromError + remainingDelta);
			}
			// The failed batch was cleared above when clearPendingStats is set (server
			// gave an authoritative balance or a non-retriable error). However,
			// concurrent rounds that arrived during the await — or remaining rounds
			// from a partial-batch split — are still in pendingRoundDeltas. The
			// resolution flags syncPending=false on an authoritative-balance rebase,
			// so without a follow-up those rounds would sit un-persisted until the
			// next spin or the unload beacon (a completed second spin can appear in
			// the UI without being synced if the player stops there). Mirror the
			// success path: flush whenever pending rounds remain, gated by the retry
			// cap to bound the loop.
			const hasRemainingRounds = this.pendingRoundDeltas.length > 0;
			if (
				(resolution.syncPending || hasRemainingRounds) &&
				!shouldAbandonFollowUpSync(this.followUpAttempts)
			) {
				this.followUpAttempts++;
				this.pendingRetryTimer = true;
				this.deps.setTimeoutImpl(
					() => this.runSync(0),
					getFollowUpBackoffDelayMs(this.followUpAttempts),
				);
			} else {
				this.isSyncInProgress = false;
			}
		} catch (_e) {
			if (!shouldAbandonFollowUpSync(this.followUpAttempts)) {
				this.followUpAttempts++;
				this.pendingRetryTimer = true;
				this.deps.setTimeoutImpl(
					() => this.runSync(0),
					getFollowUpBackoffDelayMs(this.followUpAttempts),
				);
			} else {
				this.isSyncInProgress = false;
				this.deps.setGameBalance(this.serverSyncedBalance);
				// After the revert, getGameBalance() === serverSyncedBalance so
				// the beacon sends delta=0 with the pending stats — the server
				// records the win/loss/hand aggregates without applying a
				// balance change the client has already discarded. Sending the
				// beacon before the revert would apply a delta the client threw
				// away, causing drift.
				this.flushPendingStatsViaBeacon();
				this.deps.onNetworkErrorGiveUp();
			}
		}
	}

	// Best-effort unload-time flush of pending win/loss/hand stats when the
	// normal fetch loop has given up due to repeated 429s. sendBeacon carries
	// session cookies (same-origin) so the request is authenticated, but the
	// response is unavailable — we clear pending stats optimistically. If the
	// beacon also fails (e.g. server still rate-limiting), the stats are lost,
	// which is the same outcome as not flushing; the balance is unaffected
	// because the 429 branch never applied a server-side delta.
	private flushPendingStatsViaBeacon(): void {
		if (!this.deps.sendBeaconImpl) return;
		if (this.pendingRoundDeltas.length === 0) return;
		// Cap at MAX_HANDS — the server rejects handCount > MAX. The beacon is
		// fire-and-forget so we cannot split and retry; rounds beyond the cap
		// are lost (same outcome as the server rejecting an oversized batch).
		const batchDeltas = this.pendingRoundDeltas.slice(0, MAX_SLOTS_SYNC_HANDS_PER_REQUEST);
		const snapshot = computeSlotsBatchStats(batchDeltas);
		// Use the actual balance delta (gameBalance - serverSyncedBalance), not
		// the batch sum. On the network-error give-up path the balance is
		// reverted to serverSyncedBalance before this call, so delta=0 and only
		// hand stats are recorded. On the 429 give-up path the balance is
		// unreverted, so the full pending delta is sent.
		const deltaForRequest = this.deps.getGameBalance() - this.serverSyncedBalance;
		const outcome: 'win' | 'loss' | 'push' =
			deltaForRequest > 0 ? 'win' : deltaForRequest < 0 ? 'loss' : 'push';
		const body = JSON.stringify({
			delta: deltaForRequest,
			gameType: 'slots',
			previousBalance: this.serverSyncedBalance,
			outcome,
			handCount: snapshot.handsIncrement || 1,
			winsIncrement: snapshot.winsIncrement || undefined,
			lossesIncrement: snapshot.lossesIncrement || undefined,
			biggestWinCandidate: snapshot.biggestWinCandidate,
			syncId: this.deps.generateSyncRequestId(),
		});
		try {
			this.deps.sendBeaconImpl(this.deps.endpoint, body);
			// Clear all pending — the beacon is best-effort and we cannot retry.
			// Overflow beyond the cap is lost (no response to act on).
			this.pendingRoundDeltas = [];
		} catch (_e) {
			// sendBeacon throwing is unexpected; leave pending rounds as-is.
		}
	}
}
