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
};

const RATE_LIMIT_RETRY_CAP_MS = 8000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;

export class ChipSyncCoordinator {
	private serverSyncedBalance: number;
	private isSyncInProgress = false;
	private syncPending = false;
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
		return this.isSyncInProgress;
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
		if (this.isSyncInProgress) {
			this.syncPending = true;
			return Promise.resolve();
		}
		return this.runSync();
	}

	async runSync(retryCount = 0): Promise<void> {
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
				previousBalance?: number;
				error?: string;
				newAchievements?: Array<{ name?: string; title?: string }>;
			};

			if (response.ok) {
				if (typeof data.balance === 'number') {
					const pendingDelta = this.deps.getGameBalance() - gameBalance;
					this.serverSyncedBalance = data.balance;
					this.deps.setGameBalance(data.balance + pendingDelta);
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
				this.isSyncInProgress = false;
				if (retryCount >= MAX_FOLLOW_UP_ATTEMPTS) {
					console.warn('[slots] chip sync gave up after 429 rate-limit retries; balance may drift');
					this.deps.onRateLimitGiveUp();
					return;
				}
				const retryAfter = Number(
					response.headers.get('Retry-After') ?? DEFAULT_RETRY_AFTER_SECONDS,
				);
				this.deps.setTimeoutImpl(
					() => this.runSync(retryCount + 1),
					Math.min(retryAfter * 1000, RATE_LIMIT_RETRY_CAP_MS),
				);
				return;
			}

			const resolution = resolveSlotsSyncState({
				error: data.error,
				hasServerBalance: typeof data.balance === 'number',
			});
			if (typeof data.balance === 'number') {
				const pendingDelta = this.deps.getGameBalance() - gameBalance;
				this.serverSyncedBalance = data.balance;
				this.deps.setGameBalance(data.balance + pendingDelta);
			}
			this.pendingStats = resolution.clearPendingStats
				? subtractPendingStats(this.pendingStats, snapshot)
				: this.pendingStats;
			this.isSyncInProgress = false;
			if (resolution.syncPending && !shouldAbandonFollowUpSync(this.followUpAttempts)) {
				this.followUpAttempts++;
				this.deps.setTimeoutImpl(
					() => this.runSync(0),
					getFollowUpBackoffDelayMs(this.followUpAttempts),
				);
			}
		} catch (_e) {
			this.isSyncInProgress = false;
			if (!shouldAbandonFollowUpSync(this.followUpAttempts)) {
				this.followUpAttempts++;
				this.deps.setTimeoutImpl(
					() => this.runSync(0),
					getFollowUpBackoffDelayMs(this.followUpAttempts),
				);
			} else {
				this.deps.setGameBalance(this.serverSyncedBalance);
				this.deps.onNetworkErrorGiveUp();
			}
		}
	}
}
