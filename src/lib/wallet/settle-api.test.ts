import { describe, expect, test } from 'bun:test';
import type { APIRoute } from 'astro';
import { createPostHandler } from '../../pages/api/wallet/settle';
import { WalletSettlementDomainError } from './settle';
import type { SettleRoundCommand, SettleRoundResult } from './types';

const COMMAND: SettleRoundCommand = {
	settlementId: 'baccarat-round-1',
	game: 'baccarat',
	delta: -25,
	stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
};
const RESULT: SettleRoundResult = { balance: 975, duplicate: false };

function context({
	session = true,
	db = {} as D1Database | null,
	body = COMMAND,
}: {
	session?: boolean;
	db?: D1Database | null;
	body?: unknown;
} = {}): Parameters<APIRoute>[0] {
	return {
		locals: {
			session: session ? ({ user: { id: 'user-1' } } as App.Locals['session']) : null,
			runtime: { env: db ? { DB: db } : {} },
		},
		request: new Request('https://arcturus.example/api/wallet/settle', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	} as unknown as Parameters<APIRoute>[0];
}

async function json(response: Response): Promise<unknown> {
	return response.json();
}

describe('POST /api/wallet/settle', () => {
	test('requires an authenticated session', async () => {
		const response = await createPostHandler({ settle: async () => RESULT })(
			context({ session: false }),
		);
		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});

	test('rejects requests without a database binding', async () => {
		let called = false;
		const response = await createPostHandler({
			settle: async () => {
				called = true;
				return RESULT;
			},
		})(context({ db: null }));

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'DATABASE_UNAVAILABLE' });
		expect(called).toBe(false);
	});

	test('rejects malformed JSON before invoking the use case', async () => {
		let called = false;
		const request = new Request('https://arcturus.example/api/wallet/settle', {
			method: 'POST',
			body: '{not-json',
		});
		const response = await createPostHandler({
			settle: async () => {
				called = true;
				return RESULT;
			},
		})({ ...context(), request });

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_JSON' });
		expect(called).toBe(false);
	});

	test('passes the session user and command to the use case', async () => {
		const calls: Array<{ d1: D1Database; userId: string; command: unknown }> = [];
		const db = {} as D1Database;
		const response = await createPostHandler({
			settle: async (d1, userId, command) => {
				calls.push({ d1, userId, command });
				return RESULT;
			},
		})(context({ db }));

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual(RESULT);
		expect(calls).toEqual([{ d1: db, userId: 'user-1', command: COMMAND }]);
	});

	test('maps domain errors to their stable HTTP status and code', async () => {
		const cases: Array<[string, number]> = [
			['INVALID_COMMAND', 400],
			['INSUFFICIENT_BALANCE', 400],
			['USER_NOT_FOUND', 500],
			['SETTLEMENT_CONFLICT', 409],
		];

		for (const [code, status] of cases) {
			const response = await createPostHandler({
				settle: async () => {
					throw new WalletSettlementDomainError(code as never);
				},
			})(context());
			expect(response.status).toBe(status);
			expect(await json(response)).toEqual({ error: code });
		}
	});
});
