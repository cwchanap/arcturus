import { describe, expect, test } from 'bun:test';
import { ChipSyncCoordinator, type ChipSyncResponse } from './chip-sync-coordinator';
import type { SpinResult, SymbolId } from './types';

type FetchScript = Array<
	| { kind: 'ok'; balance?: number; newAchievements?: Array<{ name?: string; title?: string }> }
	| { kind: '429'; retryAfter?: number }
	| { kind: 'error'; status?: number; error?: string; currentBalance?: number }
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
		sendBeacon: (url: string, body: string) => boolean;
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
	const beaconCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

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
				body: { error: step.error, currentBalance: step.currentBalance },
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
		sendBeaconImpl: overrides?.sendBeacon
			? (url: string, body: string) => {
					beaconCalls.push({ url, body: JSON.parse(body) as Record<string, unknown> });
					return overrides!.sendBeacon!(url, body);
				}
			: undefined,
	};

	return {
		deps,
		getBalance: () => balance,
		getFetchCalls: () => fetchCalls,
		getScheduled: () => scheduled,
		getAchievements: () => achievements,
		getGiveUpCount: () => giveUpCount,
		getNetworkGiveUpCount: () => networkGiveUpCount,
		getBeaconCalls: () => beaconCalls,
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
		grid: [['cherry', 'cherry', 'cherry'] as SymbolId[]],
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

	test('429 give-up flushes pending stats via sendBeacon and clears them', async () => {
		const ctx = makeDeps({
			balance: 1090,
			script: [
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
			],
			sendBeacon: () => true,
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(90));
		await ctx.runScheduled(0);
		await ctx.runScheduled(1);
		await ctx.runScheduled(2);

		expect(ctx.getGiveUpCount()).toBe(1);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		const beacons = ctx.getBeaconCalls();
		expect(beacons).toHaveLength(1);
		expect(beacons[0].body.gameType).toBe('slots');
		expect(beacons[0].body.delta).toBe(90);
		expect(beacons[0].body.handCount).toBe(1);
	});

	test('429 give-up without sendBeacon dep drops pending stats (graceful)', async () => {
		const ctx = makeDeps({
			balance: 1090,
			script: [
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
				{ kind: '429', retryAfter: 0 },
			],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(90));
		await ctx.runScheduled(0);
		await ctx.runScheduled(1);
		await ctx.runScheduled(2);

		expect(ctx.getGiveUpCount()).toBe(1);
		expect(ctx.getBeaconCalls()).toHaveLength(0);
		// pendingStats remain unflushed — same as pre-beacon behavior.
		expect(coord.getPendingStats().handsIncrement).toBe(1);
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

	test('network error give-up flushes pending stats via sendBeacon with delta=0 after revert', async () => {
		const ctx = makeDeps({
			balance: 1090,
			script: [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }],
			sendBeacon: () => true,
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(90));

		await ctx.runScheduled(0);
		await ctx.runScheduled(1);
		await ctx.runScheduled(2);

		expect(ctx.getNetworkGiveUpCount()).toBe(1);
		// Balance reverted to server-synced value before the beacon fires.
		expect(ctx.getBalance()).toBe(1000);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		const beacons = ctx.getBeaconCalls();
		expect(beacons).toHaveLength(1);
		expect(beacons[0].body.delta).toBe(0);
		expect(beacons[0].body.handCount).toBe(1);
		expect(beacons[0].body.winsIncrement).toBe(1);
	});

	test('terminal server error (BALANCE_MISMATCH) clears pending stats and does not retry', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [{ kind: 'error', status: 409, error: 'BALANCE_MISMATCH', currentBalance: 1000 }],
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

	// Regression guard: drive the coordinator with real serialized Response objects
	// (not the mock ChipSyncResponse shape) so field-name drift between the server's
	// actual JSON and the coordinator's parser is caught at test time. The error path
	// sends `currentBalance` (matching chips/update.ts DELTA_EXCEEDS_LIMIT /
	// BALANCE_MISMATCH responses); the success path sends `balance`.
	test('real Response: BALANCE_MISMATCH with currentBalance rebases client', async () => {
		let balance = 990;
		const deps = {
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: 'BALANCE_MISMATCH',
						message: 'Balance was modified concurrently. Please refresh and try again.',
						currentBalance: 1000,
					}),
					{ status: 409, headers: { 'Content-Type': 'application/json' } },
				) as unknown as ChipSyncResponse,
			setTimeoutImpl: () => {},
			getGameBalance: () => balance,
			setGameBalance: (n: number) => {
				balance = n;
			},
			onAchievement: () => {},
			onRateLimitGiveUp: () => {},
			onNetworkErrorGiveUp: () => {},
			generateSyncRequestId: () => 'real-resp-sync-1',
			endpoint: '/api/chips/update',
		};
		const coord = new ChipSyncCoordinator(deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(-10));
		expect(coord.getServerSyncedBalance()).toBe(1000);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.isBusy()).toBe(false);
	});

	test('real Response: success with balance updates server-synced balance', async () => {
		let balance = 1090;
		const deps = {
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						success: true,
						balance: 1090,
						previousBalance: 1000,
						delta: 90,
						newAchievements: [],
						warnings: [],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				) as unknown as ChipSyncResponse,
			setTimeoutImpl: () => {},
			getGameBalance: () => balance,
			setGameBalance: (n: number) => {
				balance = n;
			},
			onAchievement: () => {},
			onRateLimitGiveUp: () => {},
			onNetworkErrorGiveUp: () => {},
			generateSyncRequestId: () => 'real-resp-sync-2',
			endpoint: '/api/chips/update',
		};
		const coord = new ChipSyncCoordinator(deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(90));
		expect(coord.getServerSyncedBalance()).toBe(1090);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.isBusy()).toBe(false);
	});

	// Regression guard: during a 429 retry wait, a new round's
	// handleRoundComplete must coalesce (set syncPending) rather than
	// calling runSync directly — otherwise the scheduled retry and the
	// new round's fetch run concurrently, causing balance drift.
	test('new round during 429 retry wait coalesces instead of racing', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [
				{ kind: '429', retryAfter: 0 },
				{ kind: 'ok', balance: 985 },
			],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);

		await coord.handleRoundComplete(makeSpinResult(-10, 'spin-1'));
		// 429 received → retry scheduled, coordinator still busy.
		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(ctx.getScheduled()).toHaveLength(1);
		expect(coord.isBusy()).toBe(true);

		// Spin 2 arrives during the retry wait.
		ctx.deps.getGameBalance = () => 985;
		await coord.handleRoundComplete(makeSpinResult(-5, 'spin-2'));
		// Must NOT have fired a second fetch — spin-2 coalesces.
		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(coord.getPendingStats().handsIncrement).toBe(2);

		// Retry fires → succeeds → flushes coalesced spin-2 stats.
		await ctx.runScheduled(0);
		expect(ctx.getFetchCalls()).toHaveLength(2);
		// The retry's delta covers both rounds: -10 + -5 = -15.
		expect(ctx.getFetchCalls()[1].body.delta).toBe(-15);
		expect(ctx.getFetchCalls()[1].body.handCount).toBe(2);
		expect(coord.getServerSyncedBalance()).toBe(985);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		expect(coord.isBusy()).toBe(false);
	});

	// Regression guard: same race but via the network-error catch path.
	test('new round during network-error retry wait coalesces instead of racing', async () => {
		const ctx = makeDeps({
			balance: 990,
			script: [{ kind: 'throw' }, { kind: 'ok', balance: 985 }],
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);

		await coord.handleRoundComplete(makeSpinResult(-10, 'spin-1'));
		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(ctx.getScheduled()).toHaveLength(1);
		expect(coord.isBusy()).toBe(true);

		ctx.deps.getGameBalance = () => 985;
		await coord.handleRoundComplete(makeSpinResult(-5, 'spin-2'));
		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(coord.getPendingStats().handsIncrement).toBe(2);

		await ctx.runScheduled(0);
		expect(ctx.getFetchCalls()).toHaveLength(2);
		expect(ctx.getFetchCalls()[1].body.delta).toBe(-15);
		expect(coord.getServerSyncedBalance()).toBe(985);
		expect(coord.isBusy()).toBe(false);
	});

	// Regression: 200 OK without a balance field is an unexpected server
	// response. The coordinator should warn (observability) and still clear
	// pending stats (the server returned OK, so it processed them).
	test('200 OK without balance field warns and clears pending stats', async () => {
		const warnSpy = jestSpyConsoleWarn();
		const ctx = makeDeps({
			balance: 1090,
			script: [{ kind: 'ok' }], // no balance field
		});
		const coord = new ChipSyncCoordinator(ctx.deps, 1000);
		await coord.handleRoundComplete(makeSpinResult(90));

		expect(ctx.getFetchCalls()).toHaveLength(1);
		expect(coord.getPendingStats().handsIncrement).toBe(0);
		// serverSyncedBalance not updated (no balance to rebase from)
		expect(coord.getServerSyncedBalance()).toBe(1000);
		expect(warnSpy.called).toBe(true);
		warnSpy.restore();
	});
});

function jestSpyConsoleWarn(): { called: boolean; restore: () => void } {
	const original = console.warn;
	let called = false;
	console.warn = (..._args: unknown[]) => {
		called = true;
	};
	return {
		get called() {
			return called;
		},
		restore: () => {
			console.warn = original;
		},
	};
}
