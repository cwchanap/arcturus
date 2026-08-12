import { describe, expect, mock, test } from 'bun:test';
import { WALLET_SETTLEMENT_TIMEOUT_MS, submitWalletSettlement } from './client';
import type { SettleRoundCommand } from './types';

const COMMAND: SettleRoundCommand = {
	settlementId: 'slots-round-1',
	game: 'slots',
	delta: 25,
	stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 25 },
};

describe('submitWalletSettlement', () => {
	test('posts one JSON command with the fixed timeout and returns the response body', async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const previousFetch = globalThis.fetch;
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response(JSON.stringify({ balance: 1025, duplicate: false }), { status: 200 });
		}) as unknown as typeof fetch;

		try {
			await expect(submitWalletSettlement(COMMAND)).resolves.toEqual({
				balance: 1025,
				duplicate: false,
			});
		} finally {
			globalThis.fetch = previousFetch;
		}

		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.input)).toBe('/api/wallet/settle');
		expect(calls[0]?.init?.method).toBe('POST');
		expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(COMMAND);
		expect(WALLET_SETTLEMENT_TIMEOUT_MS).toBe(15_000);
	});

	test('does not retry a non-success response', async () => {
		let calls = 0;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			calls += 1;
			return new Response(JSON.stringify({ message: 'INSUFFICIENT_BALANCE' }), { status: 400 });
		}) as unknown as typeof fetch;

		try {
			await expect(submitWalletSettlement(COMMAND)).rejects.toThrow('INSUFFICIENT_BALANCE');
		} finally {
			globalThis.fetch = previousFetch;
		}

		expect(calls).toBe(1);
	});

	test('does not retry a timeout rejection', async () => {
		let calls = 0;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			calls += 1;
			throw new DOMException('timed out', 'AbortError');
		}) as unknown as typeof fetch;

		try {
			await expect(submitWalletSettlement(COMMAND)).rejects.toThrow('timed out');
		} finally {
			globalThis.fetch = previousFetch;
		}

		expect(calls).toBe(1);
	});
});
