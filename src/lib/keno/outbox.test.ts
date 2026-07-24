// src/lib/keno/outbox.test.ts
import { describe, expect, test } from 'bun:test';
import { KenoSyncOutbox } from './outbox';
import type { PendingReceipt } from './outbox';

type FetchCall = { url: string; body: Record<string, unknown> };
type FetchResult = { status: number; body: Record<string, unknown> };

function makeFetch(results: FetchResult[]) {
	const calls: FetchCall[] = [];
	let i = 0;
	const fetchImpl = async (url: string, init: { body: string }) => {
		calls.push({ url, body: JSON.parse(init.body) });
		const r = results[Math.min(i, results.length - 1)];
		i++;
		return {
			ok: r.status === 200,
			status: r.status,
			headers: { get: (k: string) => (k === 'Retry-After' ? '1' : null) },
			json: async () => r.body,
		};
	};
	return { fetchImpl, calls };
}

function receipt(syncId: string, previousBalance: number, delta: number): PendingReceipt {
	return {
		syncId,
		previousBalance,
		delta,
		gameType: 'keno',
		outcome: delta > 0 ? 'win' : delta < 0 ? 'loss' : 'push',
		handCount: 1,
		biggestWinCandidate: delta > 0 ? delta : undefined,
	};
}

describe('KenoSyncOutbox payload contract', () => {
	test('sends exactly the 7 canonical fields; never statsDelta/winsIncrement/lossesIncrement', async () => {
		const { fetchImpl, calls } = makeFetch([{ status: 200, body: { balance: 1100 } }]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(1);
		expect(calls[0].body).toEqual({
			syncId: 's1',
			previousBalance: 1000,
			delta: 100,
			gameType: 'keno',
			outcome: 'win',
			handCount: 1,
			biggestWinCandidate: 100,
		});
	});
});

describe('KenoSyncOutbox serialization', () => {
	test('two rapid receipts drain serially: 2nd previousBalance = 1st committed balance', async () => {
		const { fetchImpl, calls } = makeFetch([
			{ status: 200, body: { balance: 1100 } },
			{ status: 200, body: { balance: 1090 } },
		]);
		const rebalanced: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: (b) => rebalanced.push(b),
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		await ob.enqueueAndDrain(receipt('s2', 1100, -10)); // previousBalance mirrors s1's committed 1100
		expect(calls[1].body.previousBalance).toBe(1100);
		expect(rebalanced).toEqual([1100, 1090]);
	});
});

describe('KenoSyncOutbox BALANCE_MISMATCH (rebase + resubmit, delta preserved)', () => {
	test('rebases previousBalance := currentBalance, keeps syncId+delta, retries', async () => {
		const { fetchImpl, calls } = makeFetch([
			{ status: 409, body: { error: 'BALANCE_MISMATCH', currentBalance: 1050 } },
			{ status: 200, body: { balance: 1150 } },
		]);
		const rebalanced: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: (b) => rebalanced.push(b),
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(2);
		expect(calls[0].body.previousBalance).toBe(1000);
		expect(calls[1].body).toEqual({
			// rebased previousBalance, SAME syncId + delta
			syncId: 's1',
			previousBalance: 1050,
			delta: 100,
			gameType: 'keno',
			outcome: 'win',
			handCount: 1,
			biggestWinCandidate: 100,
		});
		expect(rebalanced).toEqual([1050, 1150]); // final committed balance adopted
	});
	test('bounded rebases fall through to terminal handling (no infinite loop)', async () => {
		// Every attempt returns BALANCE_MISMATCH — exhaust the rebase bound, then terminal-drop.
		const { fetchImpl, calls } = makeFetch([
			{ status: 409, body: { error: 'BALANCE_MISMATCH', currentBalance: 1050 } },
		]);
		let hardError: string | undefined = undefined;
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: (code) => (hardError = code),
			onToast: () => {},
			maxRebases: 3,
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls.length).toBeLessThanOrEqual(4); // 3 rebases + 1 terminal drop
		expect(hardError!).toBe('BALANCE_MISMATCH');
	});
});

describe('KenoSyncOutbox 429 (re-queue same payload at head)', () => {
	test('retries the identical 7-field payload after Retry-After', async () => {
		const { fetchImpl, calls } = makeFetch([
			{ status: 429, body: { error: 'RATE_LIMITED' } },
			{ status: 200, body: { balance: 1100 } },
		]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			sleep: () => Promise.resolve(),
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(2);
		expect(calls[1].body.syncId).toBe('s1');
		expect(calls[1].body.delta).toBe(100);
	});
});

describe('KenoSyncOutbox terminal 4xx (drop, no loop)', () => {
	test('DELTA_EXCEEDS_LIMIT drops the receipt and surfaces hard error', async () => {
		const { fetchImpl, calls } = makeFetch([
			{ status: 400, body: { error: 'DELTA_EXCEEDS_LIMIT', currentBalance: 1000 } },
		]);
		let hardError: string | undefined = undefined;
		let adopted = -1;
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: (b) => (adopted = b),
			onHardError: (code) => (hardError = code),
			onToast: () => {},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 999999));
		expect(calls).toHaveLength(1); // no retry
		expect(hardError!).toBe('DELTA_EXCEEDS_LIMIT');
		expect(adopted).toBe(1000);
	});
});

describe('KenoSyncOutbox network failure (leave at head, retry full payload)', () => {
	test('does NOT adopt local balance; retries identical payload', async () => {
		let attempt = 0;
		const calls: FetchCall[] = [];
		const fetchImpl = async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			attempt++;
			if (attempt === 1) throw new Error('network');
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({ balance: 1100 }),
			};
		};
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			maxNetworkRetries: 1,
			sleep: () => Promise.resolve(),
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(2);
		expect(calls[1].body).toEqual(calls[0].body);
	});
});

describe('KenoSyncOutbox malformed JSON on 200 (item 6)', () => {
	test('res.json() throwing is retried, not an unhandled rejection', async () => {
		let attempt = 0;
		const calls: FetchCall[] = [];
		const fetchImpl = async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			attempt++;
			if (attempt === 1) {
				return {
					ok: true,
					status: 200,
					headers: { get: () => null },
					json: async () => {
						throw new SyntaxError('Unexpected token');
					},
				};
			}
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({ balance: 1100 }),
			};
		};
		const synced: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: (b) => synced.push(b),
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			sleep: () => Promise.resolve(),
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(2); // retried after parse failure
		expect(synced).toEqual([1100]); // adopted real balance, not dropped
	});
});

describe('KenoSyncOutbox non-numeric balance on 200 (item 3)', () => {
	test('malformed balance field is retried, does not adopt 0', async () => {
		const { fetchImpl, calls } = makeFetch([
			{ status: 200, body: { balance: 'oops' } },
			{ status: 200, body: { balance: 1100 } },
		]);
		const synced: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: (b) => synced.push(b),
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			sleep: () => Promise.resolve(),
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(2); // retried
		expect(synced).toEqual([1100]); // never adopted 0
	});
});

describe('KenoSyncOutbox persistence (resume on load)', () => {
	test('re-drains persisted receipts from load()', async () => {
		let persisted: PendingReceipt[] = [receipt('s-old', 500, 50)];
		const { fetchImpl, calls } = makeFetch([{ status: 200, body: { balance: 550 } }]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: (r) => (persisted = r),
			load: () => persisted,
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
		});
		await ob.drainPersisted();
		expect(calls).toHaveLength(1);
		expect(calls[0].body.syncId).toBe('s-old');
	});

	test('drainPersisted returns count drained so caller can reconcile game balance', async () => {
		// Simulate a page reload with two persisted receipts (a win then a loss)
		// that were applied to the previous tab's game but never synced.
		let persisted: PendingReceipt[] = [receipt('s-win', 1000, 100), receipt('s-loss', 1100, -30)];
		const syncedBalances: number[] = [];
		const { fetchImpl } = makeFetch([
			{ status: 200, body: { balance: 1100 } },
			{ status: 200, body: { balance: 1070 } },
		]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: (r) => (persisted = r),
			load: () => persisted,
			setServerSyncedBalance: (b) => syncedBalances.push(b),
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
		});

		const drained = await ob.drainPersisted();
		expect(drained).toBe(2);
		// Caller can now reconcile: game.setBalance(serverSyncedBalance) == 1070
		expect(syncedBalances).toEqual([1100, 1070]);
		expect(persisted).toEqual([]); // queue cleared
	});

	test('drainPersisted returns 0 when queue is empty', async () => {
		const { fetchImpl, calls } = makeFetch([{ status: 200, body: { balance: 1000 } }]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
		});
		const drained = await ob.drainPersisted();
		expect(drained).toBe(0);
		expect(calls).toHaveLength(0);
	});

	test('drainPersisted returns partial count when drain pauses (MP_ESCROW)', async () => {
		let persisted: PendingReceipt[] = [receipt('s1', 1000, 100), receipt('s2', 1100, -50)];
		const { fetchImpl } = makeFetch([
			{ status: 200, body: { balance: 1100 } },
			{ status: 409, body: { error: 'MP_ESCROW_ACTIVE' } },
		]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: (r) => (persisted = r),
			load: () => persisted,
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			maxEscrowRetries: 0, // pause immediately, no retry loop
			sleep: () => Promise.resolve(),
		});
		const drained = await ob.drainPersisted();
		expect(drained).toBe(1); // only the first receipt consumed
		expect(persisted).toHaveLength(1); // second still queued
	});
});

describe('KenoSyncOutbox MP_ESCROW bounded retry (item 2)', () => {
	test('retries MP_ESCROW up to maxEscrowRetries then pauses (leave at head)', async () => {
		const calls: FetchCall[] = [];
		let callIdx = 0;
		const results: FetchResult[] = [
			{ status: 409, body: { error: 'MP_ESCROW_ACTIVE' } },
			{ status: 409, body: { error: 'MP_ESCROW_ACTIVE' } },
			{ status: 200, body: { balance: 1100 } },
		];
		const fetchImpl = async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			const r = results[Math.min(callIdx, results.length - 1)];
			callIdx++;
			return {
				ok: r.status === 200,
				status: r.status,
				headers: { get: () => null },
				json: async () => r.body,
			};
		};
		const sleeps: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			maxEscrowRetries: 2,
			escrowRetryMs: 2000,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		// 2 escrow retries (each a sleep) then 3rd attempt succeeds
		expect(calls).toHaveLength(3);
		expect(sleeps).toEqual([2000, 2000]);
	});

	test('exhausting escrow retries leaves receipt at head and toasts', async () => {
		const { fetchImpl, calls } = makeFetch([{ status: 409, body: { error: 'MP_ESCROW_ACTIVE' } }]);
		let toasted = '';
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: (m) => (toasted = m),
			maxEscrowRetries: 1,
			escrowRetryMs: 100,
			sleep: () => Promise.resolve(),
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		// 1 retry attempt + 1 exhaustion attempt = 2 calls, then pause
		expect(calls).toHaveLength(2);
		expect(toasted).toContain('multiplayer hand in progress');
	});
});

describe('KenoSyncOutbox BALANCE_MISMATCH missing currentBalance (item 5)', () => {
	test('malformed MISMATCH body (no currentBalance) terminal-drops, never rebases to 0', async () => {
		const { fetchImpl, calls } = makeFetch([
			{ status: 409, body: { error: 'BALANCE_MISMATCH' } }, // no currentBalance field
		]);
		let hardError: string | undefined = undefined;
		const synced: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: (b) => synced.push(b),
			setGameBalance: () => {},
			onHardError: (code) => (hardError = code),
			onToast: () => {},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, 100));
		expect(calls).toHaveLength(1); // no rebase retry
		expect(hardError).toBe('BALANCE_MISMATCH_MISSING_BALANCE');
		expect(synced).toEqual([]); // never adopted 0
	});
});

describe('KenoSyncOutbox resume reconcile via live drain (display drift fix)', () => {
	test('both resumed and live receipts reconcile display via setGameBalance', async () => {
		// Scenario: page reloads with one persisted receipt.
		// drainPersisted() pauses immediately (MP_ESCROW).
		// A live draw then enqueues a new receipt; the combined drain syncs
		// both. With the authoritative-balance model, every 200 reconciles
		// the display to serverBalance + sum(remaining queue deltas):
		//   resumed 200 (balance=1100): queue=[s-live delta=-10], display=1090
		//   live 200 (balance=1090): queue=[], display=1090
		let persisted: PendingReceipt[] = [receipt('s-resumed', 1000, 100)];
		const setGameBalanceCalls: number[] = [];
		let callIdx = 0;
		const results: FetchResult[] = [
			{ status: 409, body: { error: 'MP_ESCROW_ACTIVE' } }, // drainPersisted pauses
			{ status: 200, body: { balance: 1100 } }, // resumed receipt syncs via live drain
			{ status: 200, body: { balance: 1090 } }, // live receipt syncs
		];
		const fetchImpl = async (url: string, init: { body: string }) => {
			const r = results[Math.min(callIdx, results.length - 1)];
			callIdx++;
			return {
				ok: r.status === 200,
				status: r.status,
				headers: { get: () => null },
				json: async () => r.body,
			};
		};

		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: (r) => (persisted = r),
			load: () => persisted,
			setServerSyncedBalance: () => {},
			setGameBalance: (b) => setGameBalanceCalls.push(b),
			onHardError: () => {},
			onToast: () => {},
			maxEscrowRetries: 0, // pause immediately on escrow
			sleep: () => Promise.resolve(),
		});

		// drainPersisted pauses on MP_ESCROW — resumed receipt still queued
		const drained = await ob.drainPersisted();
		expect(drained).toBe(0);
		expect(setGameBalanceCalls).toEqual([]); // nothing synced yet

		// Live draw enqueues a new receipt; drain resumes and syncs both
		await ob.enqueueAndDrain(receipt('s-live', 1100, -10));

		// Resumed receipt's 200 → reconcile(1100): queue=[s-live delta=-10],
		//   display = 1100 + (-10) = 1090
		// Live receipt's 200 → reconcile(1090): queue=[], display = 1090
		expect(setGameBalanceCalls).toEqual([1090, 1090]);
	});
});

describe('KenoSyncOutbox fire-and-forget (per-draw delta race regression)', () => {
	test('rapid fire-and-forget draws do not corrupt game balance', async () => {
		let serverBalance = 1000;
		let gameBalance = 1000;
		const setGameBalanceCalls: number[] = [];
		const calls: FetchCall[] = [];
		let callIdx = 0;
		const results: FetchResult[] = [
			{ status: 200, body: { balance: 995 } }, // s1: 1000 + (-5) = 995
			{ status: 409, body: { error: 'BALANCE_MISMATCH', currentBalance: 995 } }, // s2 stale prevBalance
			{ status: 200, body: { balance: 990 } }, // s2 rebased: 995 + (-5) = 990
		];
		const fetchImpl = async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			const r = results[Math.min(callIdx, results.length - 1)];
			callIdx++;
			// Slow first call to simulate sync RTT > animation delay
			if (callIdx === 1) await new Promise<void>((resolve) => setTimeout(resolve, 30));
			return {
				ok: r.status === 200,
				status: r.status,
				headers: { get: (k: string) => (k === 'Retry-After' ? '1' : null) },
				json: async () => r.body,
			};
		};

		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: (b) => {
				serverBalance = b;
			},
			setGameBalance: (b) => {
				setGameBalanceCalls.push(b);
			},
			onHardError: () => {},
			onToast: () => {},
			sleep: () => Promise.resolve(),
		});

		// Draw 1: gameBalance 1000 -> 995, per-draw delta = -5
		gameBalance = 995;
		// Fire-and-forget (production pattern: void enqueueAndDrain)
		void ob.enqueueAndDrain({
			syncId: 's1',
			previousBalance: 1000,
			delta: -5,
			gameType: 'keno',
			outcome: 'loss',
			handCount: 1,
			biggestWinCandidate: undefined,
		});

		// Draw 2 happens while s1 sync is in flight: gameBalance 995 -> 990, per-draw delta = -5
		gameBalance = 990;
		// previousBalance still 1000 (serverSyncedBalance not yet updated - race window)
		await ob.enqueueAndDrain({
			syncId: 's2',
			previousBalance: 1000,
			delta: -5,
			gameType: 'keno',
			outcome: 'loss',
			handCount: 1,
			biggestWinCandidate: undefined,
		});

		// Wait for background drain to complete (s1 has 30ms delay)
		await new Promise((r) => setTimeout(r, 100));

		// Per-draw deltas are correct (each -5, NOT cumulative -10)
		expect(calls[0].body.delta).toBe(-5); // s1
		expect(calls[1].body.delta).toBe(-5); // s2 first attempt (before rebase)

		// gameBalance (the test's local var) is unchanged — the mock callback
		// doesn't assign. The outbox DID call setGameBalance via reconcile, but
		// with the correct value: serverBalance + remaining queue deltas = 990.
		expect(gameBalance).toBe(990);
		// Every reconciliation sets display = serverBalance + unsettled deltas.
		// After s1's 200 (995): queue=[s2 -5], display=990.
		// After s2's rebase (995): queue=[s2 -5], display=990.
		// After s2's 200 (990): queue=[], display=990.
		expect(setGameBalanceCalls.every((b) => b === 990)).toBe(true);
		expect(setGameBalanceCalls.length).toBeGreaterThan(0);

		// serverSyncedBalance was updated correctly through the drain
		expect(serverBalance).toBe(990);
	});
});

// ---------------------------------------------------------------------------
// Authoritative balance + unsettled deltas model (review items 1 & 2).
// display = serverSyncedBalance + sum(unsettled queued deltas) after every
// server reconciliation. This fixes:
//   item 1: persisted receipt 200 overwrites game balance, leaving live draw
//           delta un-reflected (live 200 skipped setGameBalance).
//   item 2: BALANCE_MISMATCH rebase updates serverSyncedBalance but not the
//           display; terminal drop overwrites display without replaying later
//           optimistic deltas already queued.
// ---------------------------------------------------------------------------
describe('KenoSyncOutbox authoritative balance reconciliation (items 1 & 2)', () => {
	test('200 response sets display = serverBalance + remaining queue deltas', async () => {
		// Two live receipts queued. First settles with 200.
		// After first 200: display = 1095 + (-5) = 1090 (second delta still pending).
		const { fetchImpl } = makeFetch([
			{ status: 200, body: { balance: 1095 } },
			{ status: 200, body: { balance: 1090 } },
		]);
		const setGameBalanceCalls: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: (b) => setGameBalanceCalls.push(b),
			onHardError: () => {},
			onToast: () => {},
		});
		void ob.enqueueAndDrain(receipt('s1', 1000, 95));
		await ob.enqueueAndDrain(receipt('s2', 1095, -5));
		// Wait for the background drain (s1 → 200 → reconcile, then s2 → 200 → reconcile)
		await new Promise((r) => setTimeout(r, 50));
		// After s1's 200: queue=[s2 delta=-5], display = 1095 + (-5) = 1090
		expect(setGameBalanceCalls).toContain(1090);
	});

	test('BALANCE_MISMATCH rebase reconciles display = serverBalance + pending delta', async () => {
		// Local baseline 1000, server changed to 900 (other tab).
		// Local draw delta -1. Rebase: previousBalance=900, delta still -1.
		// Retry 200: balance=899. Display must be 899, NOT 999 (stale local).
		const { fetchImpl } = makeFetch([
			{ status: 409, body: { error: 'BALANCE_MISMATCH', currentBalance: 900 } },
			{ status: 200, body: { balance: 899 } },
		]);
		const setGameBalanceCalls: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: (b) => setGameBalanceCalls.push(b),
			onHardError: () => {},
			onToast: () => {},
		});
		await ob.enqueueAndDrain(receipt('s1', 1000, -1));
		// After rebase: serverBalance=900, queue=[s1 delta=-1], display=900+(-1)=899
		expect(setGameBalanceCalls).toContain(899);
	});

	test('terminal drop replays remaining queued deltas into display', async () => {
		// Two receipts: r1 (delta -1) terminal-drops with currentBalance=998.
		// r2 (delta -1) is still queued. Display must be 998 + (-1) = 997,
		// NOT 998 (which would lose r2's optimistic delta).
		const { fetchImpl } = makeFetch([
			{ status: 400, body: { error: 'DELTA_EXCEEDS_LIMIT', currentBalance: 998 } },
		]);
		const setGameBalanceCalls: number[] = [];
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: (b) => setGameBalanceCalls.push(b),
			onHardError: () => {},
			onToast: () => {},
		});
		void ob.enqueueAndDrain(receipt('s1', 1000, -1));
		await ob.enqueueAndDrain(receipt('s2', 999, -1));
		// Wait for the background drain to process s1's terminal drop
		await new Promise((r) => setTimeout(r, 50));
		// After r1 terminal-drops: currentBalance=998, queue=[s2 delta=-1]
		// display = 998 + (-1) = 997
		expect(setGameBalanceCalls).toContain(997);
	});

	test('reconcileDisplay applies pending persisted deltas to game balance on init', async () => {
		// Page reload with one persisted receipt (delta=50). serverSyncedBalance=1000.
		// Before any drain completes, reconcileDisplay should set game balance
		// to 1000 + 50 = 1050 so the display reflects the pending settlement.
		let persisted: PendingReceipt[] = [receipt('s-old', 1000, 50)];
		const setGameBalanceCalls: number[] = [];
		const { fetchImpl } = makeFetch([{ status: 200, body: { balance: 1050 } }]);
		const ob = new KenoSyncOutbox({
			fetchImpl,
			endpoint: '/api/chips/update',
			persist: (r) => (persisted = r),
			load: () => persisted,
			setServerSyncedBalance: () => {},
			setGameBalance: (b) => setGameBalanceCalls.push(b),
			onHardError: () => {},
			onToast: () => {},
		});
		ob.reconcileDisplay(1000);
		expect(setGameBalanceCalls).toEqual([1050]);
	});
});
