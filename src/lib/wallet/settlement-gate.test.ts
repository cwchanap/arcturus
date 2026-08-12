import { describe, expect, test } from 'bun:test';
import { createSettlementGate, WalletSettlementError } from './settlement-gate';
import type { SettleRoundCommand, SettleRoundResult } from './types';

const COMMAND: SettleRoundCommand = {
	settlementId: 'blackjack-round-1',
	game: 'blackjack',
	delta: 50,
	stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 50 },
};
const RESULT: SettleRoundResult = { balance: 1050, duplicate: false };

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('settlement gate', () => {
	test('stores the exact command before submitting and clears it on success', async () => {
		const started = deferred<void>();
		const release = deferred<SettleRoundResult>();
		const gate = createSettlementGate({
			submit: async (command) => {
				expect(gate.pending).toBe(command);
				expect(gate.isBlocked).toBe(true);
				started.resolve();
				return release.promise;
			},
		});

		const resultPromise = gate.settle(COMMAND);
		await started.promise;
		expect(gate.pending).toBe(COMMAND);
		expect(gate.isBlocked).toBe(true);
		release.resolve(RESULT);

		await expect(resultPromise).resolves.toEqual(RESULT);
		expect(gate.pending).toBeNull();
		expect(gate.isBlocked).toBe(false);
	});

	test('keeps the exact command blocked after a failed submission', async () => {
		const gate = createSettlementGate({
			submit: async () => {
				throw new Error('offline');
			},
		});

		await expect(gate.settle(COMMAND)).rejects.toThrow('offline');
		expect(gate.pending).toBe(COMMAND);
		expect(gate.isBlocked).toBe(true);
	});

	test('retry resubmits the same object and clears only after success', async () => {
		const submitted: SettleRoundCommand[] = [];
		let attempts = 0;
		const gate = createSettlementGate({
			submit: async (command) => {
				submitted.push(command);
				attempts += 1;
				if (attempts === 1) throw new Error('offline');
				return RESULT;
			},
		});

		await expect(gate.settle(COMMAND)).rejects.toThrow('offline');
		await expect(gate.retry()).resolves.toEqual(RESULT);
		expect(submitted).toEqual([COMMAND, COMMAND]);
		expect(submitted[0]).toBe(submitted[1]);
		expect(gate.pending).toBeNull();
	});

	test('rejects a second settlement while one is in flight', async () => {
		const release = deferred<SettleRoundResult>();
		const gate = createSettlementGate({ submit: async () => release.promise });
		const first = gate.settle(COMMAND);

		expect(() => gate.settle({ ...COMMAND, settlementId: 'blackjack-round-2' })).toThrow(
			WalletSettlementError,
		);
		release.resolve(RESULT);
		await first;
	});

	test('retry is a no-op without pending work and reset clears without submitting', async () => {
		let calls = 0;
		const gate = createSettlementGate({
			submit: async () => {
				calls += 1;
				return RESULT;
			},
		});

		await expect(gate.retry()).resolves.toBeNull();
		const failed = createSettlementGate({
			submit: async () => {
				calls += 1;
				throw new Error('offline');
			},
		});
		await expect(failed.settle(COMMAND)).rejects.toThrow('offline');
		failed.reset();
		expect(failed.pending).toBeNull();
		expect(failed.isBlocked).toBe(false);
		await expect(failed.retry()).resolves.toBeNull();
		expect(calls).toBe(1);
	});
});
