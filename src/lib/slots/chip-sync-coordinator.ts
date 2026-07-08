import {
	addPendingStats,
	createPendingStats,
	getFollowUpBackoffDelayMs,
	MAX_FOLLOW_UP_ATTEMPTS,
	resolveSlotsSyncState,
	shouldAbandonFollowUpSync,
	subtractPendingStats,
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
	private pendingStats: SlotsPendingStats = createPendingStats();
	private readonly deps: ChipSyncDeps;

	constructor(deps: ChipSyncDeps, initialServerSyncedBalance: number) {
		this.deps = deps;
		this.serverSyncedBalance = initialServerSyncedBalance;
	}

	getServerSyncedBalance(): number {
		return this.serverSyncedBalance;
	}

	getPendingStats(): SlotsPendingStats {
		return { ...this.pendingStats };
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
		const isWin = result.netDelta > 0;
		const isLoss = result.netDelta < 0;
		this.pendingStats = addPendingStats(
			this.pendingStats,
			isWin ? 1 : 0,
			isLoss ? 1 : 0,
			1,
			result.netDelta,
		);
		if (this.isBusy()) {
			this.syncPending = true;
			return Promise.resolve();
		}
		return this.runSync();
	}

	async runSync(retryCount = 0): Promise<void> {
		this.pendingRetryTimer = false;
		this.isSyncInProgress = true;
		const gameBalance = this.deps.getGameBalance();
		const deltaForRequest = gameBalance - this.serverSyncedBalance;
		// A zero delta with no pending stats is a true no-op. But a round whose
		// netDelta is 0 (a push) still increments handsIncrement — we must send
		// the request so the hand is recorded, otherwise closing the tab drops
		// win/loss/leaderboard stats (balance is already correct).
		if (deltaForRequest === 0 && retryCount === 0 && this.pendingStats.handsIncrement === 0) {
			this.isSyncInProgress = false;
			return;
		}
		const snapshot = { ...this.pendingStats };
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
				if (typeof data.balance === 'number') {
					const pendingDelta = this.deps.getGameBalance() - gameBalance;
					this.serverSyncedBalance = data.balance;
					this.deps.setGameBalance(data.balance + pendingDelta);
				} else {
					// 200 OK without a balance field is an unexpected server response.
					// The balance axis self-heals on the next sync (delta is computed
					// from gameBalance - serverSyncedBalance), but this indicates a
					// server-side issue worth surfacing.
					console.warn('[slots] chip sync returned 200 OK without a balance field');
				}
				this.pendingStats = subtractPendingStats(this.pendingStats, snapshot);
				if (data.newAchievements?.length) {
					for (const a of data.newAchievements) {
						this.deps.onAchievement(a.title ?? a.name ?? 'Achievement unlocked!');
					}
				}
				this.isSyncInProgress = false;
				if (this.syncPending) {
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
			if (typeof serverBalanceFromError === 'number') {
				const pendingDelta = this.deps.getGameBalance() - gameBalance;
				this.serverSyncedBalance = serverBalanceFromError;
				this.deps.setGameBalance(serverBalanceFromError + pendingDelta);
			}
			this.pendingStats = resolution.clearPendingStats
				? subtractPendingStats(this.pendingStats, snapshot)
				: this.pendingStats;
			if (resolution.syncPending && !shouldAbandonFollowUpSync(this.followUpAttempts)) {
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
		if (this.pendingStats.handsIncrement === 0) return;
		const deltaForRequest = this.deps.getGameBalance() - this.serverSyncedBalance;
		const outcome: 'win' | 'loss' | 'push' =
			deltaForRequest > 0 ? 'win' : deltaForRequest < 0 ? 'loss' : 'push';
		const body = JSON.stringify({
			delta: deltaForRequest,
			gameType: 'slots',
			previousBalance: this.serverSyncedBalance,
			outcome,
			handCount: this.pendingStats.handsIncrement || 1,
			winsIncrement: this.pendingStats.winsIncrement || undefined,
			lossesIncrement: this.pendingStats.lossesIncrement || undefined,
			biggestWinCandidate: this.pendingStats.biggestWinCandidate,
			syncId: this.deps.generateSyncRequestId(),
		});
		try {
			this.deps.sendBeaconImpl(this.deps.endpoint, body);
			this.pendingStats = createPendingStats();
		} catch (_e) {
			// sendBeacon throwing is unexpected; leave pending stats as-is.
		}
	}
}
