import { describe, expect, test } from 'bun:test';
import { ChipSyncCoordinator, type ChipSyncResponse } from './chip-sync-coordinator';
import type { SpinResult } from './types';

type FetchScript = Array<
	| { kind: 'ok'; balance?: number; newAchievements?: Array<{ name?: string; title?: string }> }
	| { kind: '429'; retryAfter?: number }
	| { kind: 'error'; status?: number; error?: string; balance?: number }
	| { kind: 'throw' }
>;

function makeResponse(partial: {
	ok: boolean;
	status: number;
	body: unknown;
	retryAfter?: string;
}): ChipSyncResponse {
	return {
		ok: partial.ok,
		status: partial.status,
		json: async () => partial.body,
		headers: {
			get: (name: string) => (name === 'Retry-After' ? (partial.retryAfter ?? null) : null),
		},
	};
}

function makeDeps(
	overrides?: Partial<{
		balance: number;
		script: FetchScript;
		onAchievement: (title: string) => void;
		onRateLimitGiveUp: () => void;
		onNetworkErrorGiveUp: () => void;
	}>,
) {
	let balance = overrides?.balance ?? 1000;
	const script = overrides?.script ?? [];
	let callIndex = 0;
	const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	const achievements: string[] = [];
	let giveUpCount = 0;
	let networkGiveUpCount = 0;

	const deps = {
		fetchImpl: async (
			url: string,
			init: { method: string; headers: Record<string, string>; body: string },
		) => {
			fetchCalls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
			const step = script[callIndex++];
			if (!step) throw new Error('fetch script exhausted');
			if (step.kind === 'throw') throw new Error('network failure');
			if (step.kind === 'ok')
				return makeResponse({
					ok: true,
					status: 200,
					body: { balance: step.balance, newAchievements: step.newAchievements },
				});
			if (step.kind === '429')
				return makeResponse({
					ok: false,
					status: 429,
					body: {},
					retryAfter: String(step.retryAfter ?? 1),
				});
			return makeResponse({
				ok: false,
				status: step.status ?? 400,
				body: { error: step.error, balance: step.balance },
			});
		},
		setTimeoutImpl: (fn: () => void, ms: number) => {
			scheduled.push({ fn, ms });
		},
		getGameBalance: () => balance,
		setGameBalance: (n: number) => {
			balance = n;
		},
		onAchievement: (title: string) => {
			achievements.push(title);
			overrides?.onAchievement?.(title);
		},
		onRateLimitGiveUp: () => {
			giveUpCount++;
			overrides?.onRateLimitGiveUp?.();
		},
		onNetworkErrorGiveUp: () => {
			networkGiveUpCount++;
			overrides?.onNetworkErrorGiveUp?.();
		},
		generateSyncRequestId: () => `test-sync-${fetchCalls.length}`,
		endpoint: '/api/chips/update',
	};

	return {
		deps,
		getBalance: () => balance,
		getFetchCalls: () => fetchCalls,
		getScheduled: () => scheduled,
		getAchievements: () => achievements,
		getGiveUpCount: () => giveUpCount,
		getNetworkGiveUpCount: () => networkGiveUpCount,
		runScheduled: async (index = 0) => await scheduled[index].fn(),
		runAllScheduled: async () => {
			// Run scheduled callbacks in order; new ones appended during runs execute too.
			for (let i = 0; i < scheduled.length; i++) {
				await scheduled[i].fn();
			}
		},
	};
}

function makeSpinResult(netDelta: number, syncId = 'spin-1'): SpinResult {
	return {
		bet: 10,
		grid: [['cherry', 'cherry', 'cherry'] as unknown as string[]],
		payout: Math.max(0, 10 + netDelta),
		netDelta,
		timestamp: Date.now(),
		syncId,
		lineWins: [],
	};
}

describe('ChipSyncCoordinator', () => {
	test('happy path: syncs delta, updates server balance, clears pending stats', async () => {
		const ctx = makeDeps({
			balance: 1090,
			script: [{ kind: 'ok', balance: 1090 }],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(90));
		expect(ctx.getBalance()).toBe(1090);
		expect(coord.getServerSyncedBalance()).toBe(1090);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.isBusy()).toBe(false);
		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(ctx.getFetchCalls()[0].body.delta).toBe(90);
	});

	test('zero delta with no retry is a no-op (no fetch)', async () => {
		const ctx = makeDeps({ balance: 1000, script: [] });
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.runSync();
		expect(ctx.getFetchCalls()).toHaveLength(0);
		expect(coord.isBusy()).toBe(false);
	});

	test('zero-delta round (push) still flushes hand stats', async () => {
		const ctx = makeDeps({
			balance: 1000,
			script: [{ kind: 'ok', balance: 1000 }],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(0));
		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(ctx.getFetchCalls()[0].body.delta).toBe(0);
		expect(ctx.getFetchCalls()[0].body.handCount).toBe(1);
		expect(ctx.getFetchCalls()[0].body.outcome).toBe('push');
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.getServerSyncedBalance()).toBe(1000);
	});

	test('429 retries up to MAX_FOLLOW_UP_ATTEMPTS then gives up with user notice', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
			],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(-10));

		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(ctx.getScheduled()).toHaveLength(1);

		await ctx.runScheduled(0);
		expect(ctx.getFetchCalls()).toHaveLength(2);
		expect(ctx.getScheduled()).toHaveLength(2);

		await ctx.runScheduled(1);
		expect(ctx.getFetchCalls()).toHaveLength(3);
		expect(ctx.getScheduled()).toHaveLength(3);

		await ctx.runScheduled(2);
		expect(ctx.getFetchCalls()).toHaveLength(4);
		expect(ctx.getScheduled()).toHaveLength(3);
		expect(ctx.getGiveUpCount()).toBe(1);
		expect(coord.isBusy()).toBe(false);
	});

	test('429 then success resolves without give-up', async () => {
		const ctx = makeDeps({
			balance: 1050,
			script: [
				{ kind: '429', retryAfter: 0 },
				{ kind: 'ok', balance: 1050 },
			],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(50));
		expect(ctx.getScheduled()).toHaveLength(1);
		await ctx.runScheduled(0);
		expect(ctx.getFetchCalls()).toHaveLength(2);
		expect(coord.getServerSyncedBalance()).toBe(1050);
		expect(ctx.getGiveUpCount()).toBe(0);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
	});

	test('rounds completed during in-flight sync set syncPending and flush after', async () => {
		let resolveFirst: (r: ChipSyncResponse) => void = () => {};
		const firstResponse = new Promise<ChipSyncResponse>((res) => {
			resolveFirst = res;
		});
		let balance = 1080;
		const fetchCalls: Array<Record<string, unknown>> = [];
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const deps = {
			fetchImpl: async (
				_url: string,
				init: { method: string; headers: Record<string, string>; body: string },
			) => {
				fetchCalls.push(JSON.parse(init.body) as Record<string, unknown>);
				if (fetchCalls.length === 1) return firstResponse;
				return makeResponse({ ok: true, status: 200, body: { balance: 1060 } });
			},
			setTimeoutImpl: (fn: () => void, ms: number) => scheduled.push({ fn, ms }),
			getGameBalance: () => balance,
			setGameBalance: (n: number) => {
				balance = n;
			},
			onAchievement: () => {},
			onRateLimitGiveUp: () => {},
			onNetworkErrorGiveUp: () => {},
			generateSyncRequestId: () => `test-sync-${fetchCalls.length}`,
			endpoint: '/api/chips/update',
		};
		const coord = new ChipSyncCoordinator(deps, 1000);

		const first = coord.handleRoundComplete(makeSpinResult(80, 'spin-1'));
		expect(coord.isBusy()).toBe(true);

		balance = 1060;
		await coord.handleRoundComplete(makeSpinResult(-20, 'spin-2'));
		expect(fetchCalls).toHaveLength(1);
		expect(coord.getPendingStats().handsIncrement).toBe(2);

		resolveFirst(makeResponse({ ok: true, status: 200, body: { balance: 1080 } }));
		await first;

		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[1].delta).toBe(-20);
		expect(coord.getServerSyncedBalance()).toBe(1060);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
	});

	test('in-flight sync preserves spin-2 stats and pending delta when server returns balance', async () => {
		let resolveFirst: (r: ChipSyncResponse) => void = () => {};
		const firstResponse = new Promise<ChipSyncResponse>((res) => {
			resolveFirst = res;
		});
		let balance = 1080;
		const fetchCalls: Array<Record<string, unknown>> = [];
		const deps = {
			fetchImpl: async (
				_url: string,
				init: { method: string; headers: Record<string, string>; body: string },
			) => {
				fetchCalls.push(JSON.parse(init.body) as Record<string, unknown>);
				if (fetchCalls.length === 1) return firstResponse;
				return makeResponse({ ok: true, status: 200, body: { balance: 1060 } });
			},
			setTimeoutImpl: () => {},
			getGameBalance: () => balance,
			setGameBalance: (n: number) => {
				balance = n;
			},
			onAchievement: () => {},
			onRateLimitGiveUp: () => {},
			onNetworkErrorGiveUp: () => {},
			generateSyncRequestId: () => `test-sync-${fetchCalls.length}`,
			endpoint: '/api/chips/update',
		};
		const coord = new ChipSyncCoordinator(deps, 1000);

		const first = coord.handleRoundComplete(makeSpinResult(80, 'spin-1'));
		balance = 1060;
		await coord.handleRoundComplete(makeSpinResult(-20, 'spin-2'));

		resolveFirst(makeResponse({ ok: true, status: 200, body: { balance: 1080 } }));
		await first;

		expect(balance).toBe(1060);
		expect(coord.getServerSyncedBalance()).toBe(1060);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(fetchCalls[1].handCount).toBe(1);
		expect(fetchCalls[1].lossesIncrement).toBe(1);
		expect(fetchCalls[1].delta).toBe(-20);
	});

	test('network error retries with correct delta (no rollback during retry)', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [{ kind: 'throw' }, { kind: 'ok', balance: 990 }],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(-10));
		expect(ctx.getBalance()).toBe(990);
		expect(ctx.getScheduled()).toHaveLength(1);
		await ctx.runScheduled(0);
		expect(ctx.getFetchCalls()).toHaveLength(2);
		expect(ctx.getFetchCalls()[1].body.delta).toBe(-10);
		expect(coord.getServerSyncedBalance()).toBe(990);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.isBusy()).toBe(false);
	});

	test('network error give-up rolls back game balance to server state and notifies user', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(-10));

		expect(ctx.getBalance()).toBe(990);
		expect(ctx.getScheduled()).toHaveLength(1);

		await ctx.runScheduled(0);
		expect(ctx.getScheduled()).toHaveLength(2);
		expect(ctx.getBalance()).toBe(990);

		await ctx.runScheduled(1);
		expect(ctx.getScheduled()).toHaveLength(3);
		expect(ctx.getBalance()).toBe(990);

		await ctx.runScheduled(2);
		expect(ctx.getScheduled()).toHaveLength(3);
		expect(ctx.getBalance()).toBe(1000);
		expect(ctx.getNetworkGiveUpCount()).toBe(1);
		expect(coord.isBusy()).toBe(false);
	});

	test('terminal server error (BALANCE_MISMATCH) clears pending stats and does not retry', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [{ kind: 'error', status: 409, error: 'BALANCE_MISMATCH', balance: 1000 }],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(-10));
		expect(ctx.getScheduled()).toHaveLength(0);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.getServerSyncedBalance()).toBe(1000);
	});

	test('achievements from a successful sync are forwarded', async () => {
		const ctx = makeDeps({
			balance: 1100,
			script: [
				{
					kind: 'ok',
					balance: 1100,
					newAchievements: [{ title: 'Big Winner' }, { name: 'Lucky Streak' }],
				},
			],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(100));
		expect(ctx.getAchievements()).toEqual(['Big Winner', 'Lucky Streak']);
	});
});
